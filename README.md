# ORDUSION-QUIZZEZ

A Kahoot-style real-time quiz platform with Google-inspired Material UI, bulk question import, QR & numeric code joining, host-controlled question flow, host-only results, and built-in anti-cheat protection.

## Deploy on Vercel

1. Push this folder to a GitHub/GitLab/Bitbucket repository (or deploy directly with `npx vercel`).
2. Import the project in **Vercel** — `vercel.json` is already configured to serve `public/` and route `/api/*` to `api/index.js`.
3. **Recommended for multi-user live sessions on Vercel**:
   Add a free **Upstash Redis** (or **Vercel KV**) database from the Vercel Marketplace and connect it to your project. The app automatically uses `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) when present so all serverless instances share live quiz state!

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.
