# Chatimall

A WhatsApp/Telegram-style chat app: phone login (OTP), chats, voice notes, media, status/stories, channels,
voice/video calls, push notifications, Android APK.

```
chatimall/
├── frontend/   React app (deploy to Vercel; wrapped by Capacitor for the APK)
├── BACKEND/    Node + Socket.IO + MongoDB API (deploy to Render)
├── tools/      check-boundary.mjs  (proves the two folders share no code)
└── render.yaml Render blueprint for the backend
```

## The one rule
`frontend/` and `BACKEND/` communicate **only through the API** (REST + Socket.IO): no shared code, no imports
across folders. The contract is the live Swagger page at `http://localhost:4000/api/docs`. Check the boundary
any time with:
```
node tools/check-boundary.mjs
```

## Run locally (two terminals)
1. **MongoDB:** create a free Atlas cluster (or use a local MongoDB) and copy its connection string.
2. **Backend:**
   ```
   cd BACKEND && npm install
   cp .env.example .env        # set MONGODB_URI and JWT_SECRET
   npm run dev                 # http://localhost:4000/api/health
   ```
3. **Frontend:**
   ```
   cd frontend && npm install
   npm run dev                 # http://localhost:5173
   ```
4. Log in with `+15550001111` / code `123456` in one browser and `+15550002222` / `123456` in a private window.
   (While `DEV_OTP_ECHO=true`, other numbers work too: the code shows on screen and in the backend console.)

## Real OTP SMS (your part)
Edit `BACKEND/src/sms.js` or set `SMS_WEBHOOK_URL` in `BACKEND/.env`. Then set `DEV_OTP_ECHO=false`.

## Deploy: Render (backend) + Vercel (frontend)
**Backend → Render:** New → Blueprint (uses `render.yaml`, root directory `BACKEND`), or a Web Service with
Root Directory `BACKEND`, Build `npm install`, Start `npm start`, Health Check `/api/health`. Set:
`MONGODB_URI`, `CLIENT_ORIGINS` (`https://YOUR-APP.vercel.app,https://*.vercel.app,https://localhost`),
and `TEST_PHONES` (e.g. `15550001111:123456`) until your SMS provider works. Optional: `SMS_WEBHOOK_URL`,
`FCM_SERVICE_ACCOUNT`. In Atlas → Network Access allow Render (usually `0.0.0.0/0` on the free tier).
Check `https://YOUR-SERVICE.onrender.com/api/health`.

**Frontend → Vercel:** Add New Project → same repo → **Root Directory: `frontend`** (framework Vite).
Add env var `VITE_API_URL=https://YOUR-SERVICE.onrender.com` (no trailing slash) and deploy. Redeploy after
changing it, because it is baked in at build time.

**APK:** see `frontend/ANDROID.md` (uses the same `VITE_API_URL`).

Render's free plan puts the backend to sleep after about 15 minutes without traffic, so the first request
afterwards is slow. Check Render's current free-tier terms before relying on it.

## Known limits
- Calls are peer-to-peer; add a TURN server for reliable calls on mobile data.
- Direct one-to-one text messages use client-side ECDH/AES-GCM encryption and are stored as ciphertext. Peer keys are server-delivered and locally pinned after safety-code confirmation; the protocol has no ratchet or forward secrecy. Media, group messages, and calls are not end-to-end encrypted.
- Uploaded files are readable by anyone with the unguessable link.
- Group chats and chat backup/restore are not built yet.
- The backend has unit tests for its helpers but has not been run against a live MongoDB by me; expect small
  fixes on first run.
