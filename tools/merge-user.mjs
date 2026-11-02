import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Call,
  Channel,
  ChannelPost,
  Conversation,
  DeviceLinkRequest,
  DeviceToken,
  Follow,
  LinkedDevice,
  Listing,
  Message,
  StarredMessage,
  Status,
  SupportTicket,
  TikTokConnection,
  TikTokOAuthState,
  User,
  WatchSession,
} from '../BACKEND/src/models.js';

const require = createRequire(new URL('../BACKEND/package.json', import.meta.url));
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDir, '../BACKEND/.env') });

const usage = `Usage:
  node tools/merge-user.mjs <source-user-id> <target-user-id> [--apply]

Without --apply, validates the merge and prints a dry-run plan. The target account
is retained; references to the source account are reassigned before it is deleted.`;

function parseArguments(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };

  const apply = args.includes('--apply');
  const ids = args.filter((arg) => arg !== '--apply');
  if (ids.length !== 2 || ids.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    throw new Error(usage);
  }

  const [sourceId, targetId] = ids.map((id) => new mongoose.Types.ObjectId(id));
  if (sourceId.equals(targetId)) {
    throw new Error('Source and target user IDs must be different.');
  }
  return { apply, sourceId, targetId };
}

function inSession(query, session) {
  return session ? query.session(session) : query;
}

function sameId(left, right) {
  return left != null && String(left) === String(right);
}

function remapAndDedupeIds(values, sourceId, targetId) {
  const remapped = values.map((value) => (sameId(value, sourceId) ? targetId : value));
  return [...new Map(remapped.map((value) => [String(value), value])).values()];
}

function conversationFilter(sourceId) {
  return {
    $or: [
      { owner: sourceId },
      { admins: sourceId },
      { members: sourceId },
      { archivedBy: sourceId },
      { 'anonymous.vote.startedBy': sourceId },
      { 'anonymous.vote.yes': sourceId },
      { 'anonymous.vote.no': sourceId },
    ],
  };
}

async function buildPlan(sourceId, targetId, session) {
  const source = await inSession(User.findById(sourceId).select('_id linkedDeviceIds'), session).lean();
  const target = await inSession(User.findById(targetId).select('_id'), session).lean();
  if (!source) throw new Error(`Source user not found: ${sourceId}`);
  if (!target) throw new Error(`Target user not found: ${targetId}`);

  const sourceTikTokConnection = await inSession(
    TikTokConnection.findOne({ user: sourceId }).select('_id'),
    session
  ).lean();
  const targetTikTokConnection = await inSession(
    TikTokConnection.findOne({ user: targetId }).select('_id'),
    session
  ).lean();
  if (sourceTikTokConnection && targetTikTokConnection) {
    throw new Error('Both users have TikTok connections; resolve that conflict before merging.');
  }

  const directConversations = await inSession(
    Conversation.find({ isGroup: { $ne: true }, members: sourceId }).select('_id members'),
    session
  ).lean();
  for (const conversation of directConversations) {
    const members = remapAndDedupeIds(conversation.members, sourceId, targetId).map(String);
    if (members.length !== 2) {
      throw new Error(`Cannot safely merge direct conversation ${conversation._id}: it would not have two members.`);
    }

    const key = [...members].sort().join('_');
    const collision = await inSession(
      Conversation.findOne({ key, _id: { $ne: conversation._id } }).select('_id'),
      session
    ).lean();
    if (collision) {
      throw new Error(`Direct conversation key conflict between ${conversation._id} and ${collision._id}.`);
    }
  }

  const sourceFollows = await inSession(Follow.find({ user: sourceId }).select('channel'), session).lean();
  const targetFollowChannels = new Set(
    (await inSession(Follow.distinct('channel', { user: targetId }), session)).map(String)
  );
  const duplicateFollows = sourceFollows.filter((follow) => targetFollowChannels.has(String(follow.channel))).length;

  const sourceStars = await inSession(StarredMessage.find({ user: sourceId }).select('message'), session).lean();
  const targetStarredMessages = new Set(
    (await inSession(StarredMessage.distinct('message', { user: targetId }), session)).map(String)
  );
  const duplicateStars = sourceStars.filter((star) => targetStarredMessages.has(String(star.message))).length;

  const count = async (Model, filter) => inSession(Model.countDocuments(filter), session);
  const records = {
    linkedDevices: await count(LinkedDevice, { user: sourceId }),
    deviceLinkRequests: await count(DeviceLinkRequest, { user: sourceId }),
    conversations: await count(Conversation, conversationFilter(sourceId)),
    messages: await count(Message, { $or: [{ sender: sourceId }, { 'reports.user': sourceId }] }),
    statuses: await count(Status, { $or: [{ user: sourceId }, { 'views.user': sourceId }] }),
    channels: await count(Channel, { owner: sourceId }),
    follows: sourceFollows.length,
    channelPosts: await count(ChannelPost, { author: sourceId }),
    calls: await count(Call, { $or: [{ caller: sourceId }, { callee: sourceId }] }),
    deviceTokens: await count(DeviceToken, { user: sourceId }),
    starredMessages: sourceStars.length,
    supportTickets: await count(SupportTicket, { user: sourceId }),
    watchSessions: await count(WatchSession, { queuedBy: sourceId }),
    tiktokOAuthStates: await count(TikTokOAuthState, { user: sourceId }),
    tiktokConnections: sourceTikTokConnection ? 1 : 0,
    listings: await count(Listing, { seller: sourceId }),
  };

  return {
    sourceUserId: String(sourceId),
    targetUserId: String(targetId),
    sourceLinkedDeviceIds: source.linkedDeviceIds ?? [],
    records,
    duplicateFollows,
    duplicateStars,
  };
}

async function mergeUsers(plan, sourceId, targetId, session) {
  if (plan.sourceLinkedDeviceIds.length > 0) {
    await User.updateOne(
      { _id: targetId },
      { $addToSet: { linkedDeviceIds: { $each: plan.sourceLinkedDeviceIds } } },
      { session }
    );
  }

  await LinkedDevice.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });
  await DeviceLinkRequest.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });

  const conversations = await Conversation.find(conversationFilter(sourceId)).session(session);
  for (const conversation of conversations) {
    const hadSourceMember = conversation.members.some((member) => sameId(member, sourceId));

    for (const field of ['members', 'admins', 'archivedBy']) {
      conversation[field] = remapAndDedupeIds(conversation[field], sourceId, targetId);
    }
    if (sameId(conversation.owner, sourceId)) conversation.owner = targetId;

    const vote = conversation.anonymous?.vote;
    if (vote) {
      if (sameId(vote.startedBy, sourceId)) vote.startedBy = targetId;
      vote.yes = remapAndDedupeIds(vote.yes, sourceId, targetId);
      vote.no = remapAndDedupeIds(vote.no, sourceId, targetId);
    }

    const lastRead = conversation.lastRead;
    const sourceReadAt = lastRead.get(String(sourceId));
    if (sourceReadAt) {
      const targetReadAt = lastRead.get(String(targetId));
      if (!targetReadAt || sourceReadAt > targetReadAt) lastRead.set(String(targetId), sourceReadAt);
      lastRead.delete(String(sourceId));
    }

    if (hadSourceMember && !conversation.isGroup) {
      conversation.key = [...conversation.members].map(String).sort().join('_');
    }
    await conversation.save({ session });
  }

  await Message.updateMany({ sender: sourceId }, { $set: { sender: targetId } }, { session });
  await Message.updateMany(
    { 'reports.user': sourceId },
    { $set: { 'reports.$[report].user': targetId } },
    { arrayFilters: [{ 'report.user': sourceId }], session }
  );
  await Status.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });
  await Status.updateMany(
    { 'views.user': sourceId },
    { $set: { 'views.$[view].user': targetId } },
    { arrayFilters: [{ 'view.user': sourceId }], session }
  );
  await Channel.updateMany({ owner: sourceId }, { $set: { owner: targetId } }, { session });

  const targetFollowChannels = new Set(
    (await Follow.distinct('channel', { user: targetId }).session(session)).map(String)
  );
  const sourceFollows = await Follow.find({ user: sourceId }).select('_id channel').session(session);
  for (const follow of sourceFollows) {
    if (targetFollowChannels.has(String(follow.channel))) {
      await Follow.deleteOne({ _id: follow._id }, { session });
    } else {
      await Follow.updateOne({ _id: follow._id }, { $set: { user: targetId } }, { session });
    }
  }

  await ChannelPost.updateMany({ author: sourceId }, { $set: { author: targetId } }, { session });
  await Call.updateMany({ caller: sourceId }, { $set: { caller: targetId } }, { session });
  await Call.updateMany({ callee: sourceId }, { $set: { callee: targetId } }, { session });
  await DeviceToken.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });

  const targetStarredMessages = new Set(
    (await StarredMessage.distinct('message', { user: targetId }).session(session)).map(String)
  );
  const sourceStars = await StarredMessage.find({ user: sourceId }).select('_id message').session(session);
  for (const star of sourceStars) {
    if (targetStarredMessages.has(String(star.message))) {
      await StarredMessage.deleteOne({ _id: star._id }, { session });
    } else {
      await StarredMessage.updateOne({ _id: star._id }, { $set: { user: targetId } }, { session });
    }
  }

  await SupportTicket.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });
  await WatchSession.updateMany({ queuedBy: sourceId }, { $set: { queuedBy: targetId } }, { session });
  await TikTokOAuthState.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });
  await TikTokConnection.updateMany({ user: sourceId }, { $set: { user: targetId } }, { session });
  await Listing.updateMany({ seller: sourceId }, { $set: { seller: targetId } }, { session });

  const deletion = await User.deleteOne({ _id: sourceId }, { session });
  if (deletion.deletedCount !== 1) throw new Error('Source user was not deleted; transaction aborted.');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. Configure it in BACKEND/.env or the process environment.');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    if (!options.apply) {
      const plan = await buildPlan(options.sourceId, options.targetId, null);
      console.log(JSON.stringify({ mode: 'dry-run', ...plan }, null, 2));
      return;
    }

    const session = await mongoose.startSession();
    try {
      const plan = await session.withTransaction(async () => {
        const mergePlan = await buildPlan(options.sourceId, options.targetId, session);
        await mergeUsers(mergePlan, options.sourceId, options.targetId, session);
        return mergePlan;
      });
      console.log(JSON.stringify({ mode: 'applied', ...plan }, null, 2));
    } finally {
      await session.endSession();
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`User merge failed: ${error.message}`);
  process.exitCode = 1;
});
