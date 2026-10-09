# Chatimall — README (local setup in VS Code)

This zip contains the current state of the app: a WhatsApp/Telegram-style chat app
with a React + TypeScript frontend and a Node + Express + MongoDB backend.

(There's also a `README-original.md` in this folder — that's the project's original
architecture notes. This file is the step-by-step "get it running" guide.)

---

## 1. What you need installed first

- **Node.js 18 or newer** — download from nodejs.org, then confirm with `node -v`
- **MongoDB** — either:
  - a free **MongoDB Atlas** cloud cluster (easiest, no local install), or
  - MongoDB installed locally on your machine
- **VS Code** with the normal JavaScript/TypeScript support (built in, no extra extension required)

---

## 2. Unzip and open the project

1. Unzip this file anywhere on your computer.
2. Open the resulting `pulsechat` folder in VS Code (`File → Open Folder`).
3. You'll see two main folders: `BACKEND/` and `frontend/`. They run as two separate processes.

---

## 3. Set up the backend

1. Open a terminal in VS Code (`` Ctrl+` ``) and run:
   ```
   cd BACKEND
   npm install
   ```
2. Copy the example environment file:
   ```
   cp .env.example .env
   ```
   (On Windows PowerShell: `copy .env.example .env`)
3. Open the new `BACKEND/.env` file and fill in:
   - `MONGODB_URI` — your MongoDB connection string (Atlas gives you this when you create a cluster; for local Mongo, `mongodb://127.0.0.1:27017/chatimall` works as-is)
   - `JWT_SECRET` — run this once in the terminal and paste the output in:
     ```
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```
   - Leave `FCM_SERVICE_ACCOUNT`, `SMS_WEBHOOK_URL` etc. blank for now — the app runs fine locally without them (push notifications and real SMS OTP just won't fire; see Section 6).
4. Start the backend:
   ```
   npm run dev
   ```
   You should see it listening on `http://localhost:4000`. API docs are browsable at `http://localhost:4000/api/docs`.

---

## 4. Set up the frontend

1. Open a **second** terminal in VS Code (keep the backend one running) and run:
   ```
   cd frontend
   npm install
   ```
2. Copy the example environment file:
   ```
   cp .env.example .env
   ```
3. Leave `frontend/.env` empty for browser development — Vite automatically proxies API and socket calls to the backend on `localhost:4000`.
4. Start the frontend:
   ```
   npm run dev
   ```
5. Open the URL it prints (usually `http://localhost:5173`) in your browser. You should see the Chatimall sign-in screen.

---

## 5. Day-to-day: running both at once

Every time you want to work on the app:
- Terminal 1: `cd BACKEND && npm run dev`
- Terminal 2: `cd frontend && npm run dev`

Leave both running side by side while you work.

---

## 6. What's fully working right now

- Sign-up / sign-in (phone + OTP, with a dev-mode OTP echo so you don't need real SMS to test)
- 1:1 chats and group chats, with media (images/video/files/voice notes), typing indicators, read receipts
- Channels, with auto-created **Gist Rooms** (a group chat tied to a channel)
- Status / Stories, with category tabs
- Watch Together (shared YouTube/TikTok playback in a chat)
- Marketplace-style listings that open into a direct chat with the seller (no payment processing — it's a connector, not a checkout)
- Voice/video calling
- **Real end-to-end encryption** — not just schema fields. `frontend/src/lib/e2ee.ts` does genuine ECDH (P-256) key exchange + AES-GCM encryption in the browser: a device key pair generates on login and the public half publishes to the server, every text/media send is encrypted client-side (including for groups, with per-member key-wrapping), and there's a real "Verify encryption safety code" screen so people can catch a changed/spoofed key. The server only ever sees ciphertext and public keys — private keys never leave the device (confirmed: the backend validates incoming keys and rejects anything containing private-key material).
- Swagger API docs at `/api/docs`
- **Voice-note translation — rebuilt this round.** Backend: a Message now carries `translationStatus`, `transcript`, `sourceLanguage`, and a per-language `translations` cache; `BACKEND/src/translate.js` drives the pipeline; `GET /api/chats/:id/messages/:messageId/translation` fetches/lazily computes a translation; Settings has a `translation: { mode, language }` section (`off` / `text` / `audio`). Frontend: a "Translate" button under received voice notes (`ChatConversation.tsx`), and a Settings screen to pick mode + target language, with a clear "text only" label on languages that don't have a spoken voice yet. The actual ML work happens in a separate Python microservice, `translate-service/` (see below) — it's not something Node or the browser runs itself.
  - **Encryption/translation tradeoff — now resolved.** Voice notes stay end-to-end encrypted by default, same as before. But right before sending one, the app now asks the server whether the recipient has voice translation turned on (`GET /api/chats/:id/encryption-key` now also returns `peer_wants_voice_translation`). If they do, *that one voice note* is sent unencrypted instead, so the server can actually transcribe and translate it — and the sender sees a small amber notice while recording ("Sent unencrypted so it can be translated for them") so this is never a silent downgrade. Text, images, video, files, and voice notes to anyone who hasn't opted into translation are completely unaffected and stay encrypted exactly as before. This is a per-message, informed choice — not a global policy change — and it's reversible any time the recipient turns translation back off in their Settings.

## 7. The voice-translation microservice (`translate-service/`)

Three models, chained: **Whisper-tiny** (speech → text) → **MADLAD-400**, 4-bit quantized (text → text, 419 languages including Yoruba/Igbo/Hausa/Twi, Apache 2.0 licensed so it's safe for a commercial app) → **BibleTTS** voices via the `espnet/vits_tts_bibletts_char` checkpoint (text → speech, real studio recordings in Hausa, Yoruba, Ewe, Akuapem Twi, Asante Twi — Igbo and Ga aren't covered, those stay text-only).

This is a separate Python process, not part of `npm run dev`. To run it:
```
cd translate-service
pip install -r requirements.txt --break-system-packages
python download_models.py      # downloads ~2-3GB of model weights, only needs to run once
uvicorn app:app --host 0.0.0.0 --port 8787
```
Then set `TRANSLATE_SERVICE_URL=http://localhost:8787` in `BACKEND/.env` (already the default). If this service isn't running, voice notes still send and play completely normally — they just won't offer a translation. It never blocks or breaks message sending.

**Not tested end-to-end yet** — this sandbox has no internet access, so the models were never actually downloaded or run here. The Node-side code (routes, settings, schema) passed a full typecheck and the existing test suite; the Python service itself needs a first real run on your machine to confirm the three models talk to each other cleanly. Budget some debugging time for that first run.

## 8. Deploying to production

Deploy configs already exist in this zip (`render.yaml`, `frontend/vercel.json`, `frontend/capacitor.config.json`) — here's how to actually use them.

### Backend → Render
1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In the Render dashboard: **New → Blueprint**, point it at the repo. Render reads `render.yaml` and sets most things up automatically.
3. You'll be prompted for the `sync: false` values — fill in at minimum `MONGODB_URI` (your Atlas connection string) and `CLIENT_ORIGINS` (your Vercel URL, once you have it — e.g. `https://chatimall.vercel.app,https://*.vercel.app`). `JWT_SECRET` is auto-generated for you.
4. Leave `FCM_SERVICE_ACCOUNT`, `SMS_WEBHOOK_URL`, `TRANSLATE_SERVICE_URL` blank until you're ready for push notifications, real SMS, and voice translation respectively — the app runs fine without any of them.
5. Deploy. Your API will be live at something like `https://prochatx-backend.onrender.com`, with docs at `/api/docs`.

### Frontend → Vercel
1. In Vercel: **New Project**, import the same repo, set the **root directory to `frontend`**.
2. Vercel reads `vercel.json` automatically (Vite build, `dist` output, SPA rewrites).
3. Set one environment variable: `VITE_API_URL` = your Render backend URL from above.
4. Deploy. Then go back to Render and set `CLIENT_ORIGINS` to this Vercel URL if you haven't already (they reference each other).

### Android APK → Capacitor
1. `appId` is already set to `com.chatimall.app` in `frontend/capacitor.config.json` — no change needed unless you want a different package name.
2. On your machine (not in this sandbox — needs Android Studio):
   ```
   cd frontend
   npm install
   npm run build
   npx cap add android      # first time only
   npx cap sync android
   npx cap open android
   ```
3. Android Studio opens — build a signed release APK/AAB from there (Build → Generate Signed Bundle/APK). You'll need your own keystore for signing; Android Studio can create one if you don't have it yet.
4. Make sure `VITE_API_URL` was set to your real backend URL before `npm run build` — a release APK can't fall back to `localhost`.

### translate-service (optional, for voice translation)
This is a separate Python process — Render's free tier is too small for the ML models it loads, so it needs its own host (a small VPS, or a Render/Railway instance with enough RAM — budget at least 4GB). Run the same `download_models.py` + `uvicorn` steps from Section 7 on that host, then point `TRANSLATE_SERVICE_URL` (in the backend's Render env vars) at it.

## 9. What is still NOT done — honest gaps

- **Push notifications** and **real SMS OTP** — intentionally left alone this round, per your last message. The code paths exist (`FCM_SERVICE_ACCOUNT`, `SMS_WEBHOOK_URL`) but need your own credentials to go live.
- **translate-service has never actually run** — no internet access in this sandbox to download the models or test the three services talking to each other. Budget debugging time for its first real run.
- **The Android build and signed APK have not been produced** — the config is correct and ready, but actually running Android Studio and producing an APK needs to happen on your machine.


---

## 8. If something doesn't start

- **"Cannot connect to MongoDB"** → double check `MONGODB_URI` in `BACKEND/.env`, and that your Atlas cluster allows connections from your IP (or `0.0.0.0/0` while testing).
- **Frontend loads but API calls fail** → make sure the backend terminal is still running on port 4000, and that `frontend/.env` doesn't have a stale `VITE_API_URL` pointing elsewhere.
- **`npm install` errors** → confirm `node -v` is 18 or higher.
