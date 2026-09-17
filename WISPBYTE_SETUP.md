# プレイヤー — Wispbyte deployment package

This folder is intentionally stripped of Windows-only/local-development files.
It does **not** contain your Discord bot token, Discord client secret, YouTube cookies,
`node_modules`, Cloudflare Quick Tunnel, Windows `.exe` runtimes, or audio caches.

## 1. Upload

Upload the **contents of this folder** to the root of your Wispbyte server.
Do not put another copy of this folder inside itself.

## 2. Node version

Use Node.js **22.13 or newer**. The project uses Node's built-in `node:sqlite` API.

## 3. Install dependencies

Run once after uploading / reinstalling:

```bash
npm ci
```

If Wispbyte automatically installs from `package.json`, you do not need to run it twice.

## 4. Add private environment variables

Use `.env.example` only as a reference. Add these privately in Wispbyte's environment/startup settings:

- `DISCORD_TOKEN`
- `VITE_DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `BOT_PREFIX` (optional; default `!`)
- `PORT` (use Wispbyte's assigned allocation/port)
- `YOUTUBE_COOKIES_FILE` (optional)
- `AUDIO_CACHE_MAX_FILES` (optional; default 80)
- `AUDIO_CACHE_MAX_MB` (optional; default 512)

Do **not** upload your real `.env` to a public repository or send it to other people.

## 5. Startup command

Use:

```bash
npm start
```

For this deployment package, `npm start` runs:

```bash
node ensure_runtime.js && node server.js
```

`ensure_runtime.js` automatically downloads/verifies the correct Linux `yt-dlp` binary when needed.
The server already binds to `0.0.0.0` and reads `process.env.PORT`.

## 6. Frontend build

A current production `dist/` is already included, so the app can start without building on Wispbyte.
If you later edit files under `client/`, rebuild with the same Discord application ID available as
`VITE_DISCORD_CLIENT_ID`:

```bash
npm run build
```

Then restart the server.

## 7. Discord Activity URL

After Wispbyte gives you a permanent HTTPS hostname/domain, set Discord Developer Portal ->
Activities -> URL Mappings `/` to that permanent HTTPS origin. You no longer need
`START_TUNNEL.bat`, `cloudflared.exe`, or a changing `trycloudflare.com` URL.

## Existing libraries/playlists (optional migration)

The server creates `data/player.sqlite` automatically on a fresh install.
If you want to preserve the libraries/playlists/state from your local copy, fully stop the local app
and Wispbyte server first, then upload your existing `data/player.sqlite` into `data/`.
If your local database is using WAL mode, make a clean backup while the local server is stopped;
do not casually copy live `-wal` / `-shm` files while the database is running.

## YouTube cookies (optional/private)

The original private `youtube_cookies.txt` was deliberately excluded from this ZIP.
If you need it, upload your own copy privately to the project root and leave
`YOUTUBE_COOKIES_FILE=youtube_cookies.txt`. Treat that file like a credential.

## Files intentionally excluded

- `.env`
- `youtube_cookies.txt`
- `node_modules/`
- `.audio-cache/`
- `.ytjs-cache/`
- Windows `.bat` launchers
- `cloudflared.exe`
- Windows `runtime/yt-dlp.exe`
- temporary SQLite WAL/SHM files

These are either private, platform-specific, generated, cached, or only needed for local development.
