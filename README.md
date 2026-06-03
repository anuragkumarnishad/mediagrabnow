# MediaGrabNow — Instagram Downloader

Free Instagram Video / Reels / Photo / IGTV / Story / Carousel downloader.
Frontend (public/index.html) + Node.js backend (server.js).

## Run locally

```bash
npm install
npm start
```

Then open: http://localhost:3000

## Enable REAL downloads (important)

Instagram now blocks anonymous requests, so a 3rd-party API is needed.

1. Go to https://rapidapi.com and search "Instagram Downloader".
2. Subscribe to a FREE plan and copy your API key + host.
3. Start the server with your key:

```bash
RAPIDAPI_KEY=your_key_here RAPIDAPI_HOST=your_api_host npm start
```

   ...or paste them directly into server.js (RAPIDAPI_KEY / RAPIDAPI_HOST).

Without a key the site still works (UI, tabs, paste, validation), but the
Download button will show a message instead of a real file.

## Deploy

- Render / Railway / Fly.io / any Node host.
- Build command: npm install   Start command: npm start
- Add RAPIDAPI_KEY as an environment variable in the dashboard.

## Files

- public/index.html  — full website UI
- server.js          — API: /api/download (resolve) and /api/file (stream)
- package.json       — dependencies (express)

## Legal

Only download PUBLIC content you have the right to use. Not affiliated with
Instagram or Meta Platforms, Inc.
