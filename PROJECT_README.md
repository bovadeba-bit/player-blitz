# プレイヤー Phase 5.3 GEM RC4

RC4 is the mobile polish/stability pass. The main fix is that playback, WebSocket, library, and status updates no longer throw a mobile user back to the top after they have scrolled down the stacked workspace/queue. It also trims several less-visible sources of hitching and long-session memory growth.

Run `VERIFY_PHASE5.bat`, then `START_ACTIVITY_DEV.bat`, then `START_TUNNEL.bat`. If a temporary Quick Tunnel ever shows 522 again, `DIAGNOSE_522.bat` is still included; 522 remains a tunnel/origin connectivity problem rather than a player-layout problem.

## Phase 5.3 polish fixes

- preserves the mobile outer workspace position as well as the inner member, queue, and search-result scroll positions across full state renders
- defers background WebSocket-driven full renders for ~140 ms while a finger is actively scrolling, so a remote song/state change does not kill scroll momentum
- coalesces background player-state renders into animation frames instead of immediately rebuilding during every incoming event
- connection/voice/feedback status updates now patch their tiny UI elements directly instead of rebuilding the whole Activity
- custom wallpaper data is kept on the persistent `#app` root, avoiding repeated multi-megabyte base64 CSS assignment after every track change
- custom wallpaper encoding uses asynchronous `canvas.toBlob()` and a smaller mobile target, avoiding a synchronous `toDataURL()` compression loop that could freeze phones
- artwork now has a small server-side LRU cache and in-flight request coalescing so multiple clients do not repeatedly make the host PC refetch the same covers
- fixed concurrent member-library request races that could leave a folder looking stuck on Loading
- closes a stale bottom playlist picker when the current track changes, preventing the previous song from accidentally being added after autoplay/remote skip
- bounded resolver/direct-stream metadata caches so a long-running server does not grow those Maps forever
- fixed a short-phone CSS collision where the <=650px-height desktop rule could clip the two-row mobile top bar
- fixed short touch-screen landscape surfaces inheriting the old 510px minimum height
- new-query search results intentionally return to the top, while unrelated playback renders preserve whatever search-result position the user was viewing

---

# プレイヤー Phase 5.1 — App First

Phase 5 evolves the working Phase 4.4 Discord Activity instead of replacing its audio/voice foundation.
Normal use is now the Activity itself: search, click, listen, queue, browse libraries, and manage playlists without `/play`-style commands or chat output.


## Phase 5.1 live-test fixes

This package includes the first live Discord repair pass after Phase 5.0:

- stable search typing: no query scrambling/autofill-like cursor jumps during playback/WebSocket updates
- much lighter search UI path: the whole Activity is no longer rebuilt for every lookup
- stale search requests are cancelled client-side and recent exact searches are reused from a small client cache
- member folders start closed and nested Liked Songs / Saved Playlists only open when explicitly clicked
- stronger, more visible built-in/custom backgrounds with lighter glass overlays
- true narrow-screen/mobile layout instead of clipping a desktop-width interface

The desktop design is intentionally kept visually close to Phase 5.0; the changes target the reported behavior/performance/mobile problems rather than redesigning the interface.

## What Phase 5 adds

- Persistent top search bar that survives every player/WebSocket update.
- Spotify-style search dropdown with multiple music results before playback.
- Search-result actions: Play, Play Next, Like, Add to playlist.
- Search accepts normal text plus Spotify and YouTube links.
- `Slowed + reverb` and `Sped up` are mutually-exclusive search modes; both off is normal.
- Clean-audio preference: normal searches strongly prefer Topic/official-audio style results and avoid music-video/cinematic variants where a safe equivalent is available.
- High-resolution artwork selection/upscaling instead of stretching tiny 60x60 YouTube Music thumbnails.
- Fixed app layout:
  - left = server member folders, liked songs, playlists, themes
  - center = current artwork only
  - right = queue/upcoming
  - bottom = timeline + previous/play/pause/next + like/add
- Priority `Play Next` queue remains above playlist/radio continuation.
- Clicking a later queue item skips everything visible above it in that queue layer.
- Queue rows now show cover, like, play, and remove controls.
- Per-user local backgrounds: four default slots plus a local-image `+` picker.
- Audio cache is now size/count configurable instead of hard-limited to eight files.
- `!spawn` now deletes the previously-recorded launcher (when available) and posts a fresh launcher at the newest channel position.
- Routine successful actions stay silent. Necessary errors are shown unobtrusively in the player status area instead of toast spam.

## Existing Phase 4.4 systems intentionally preserved

- one Node process on port 3001 for production-built Activity + API + WebSocket + bot + music engine
- Discord Embedded App SDK session/auth flow
- server-authoritative guild player state
- SQLite likes/playlists/player state/launcher persistence
- Discord voice playback
- yt-dlp + FFmpeg fallback path
- YouTube.js / YouTube Music fast search path
- Spotify metadata -> YouTube playable-source mapping
- direct remote stream fast-start with background audio caching
- seek, previous, pause/resume, next, radio continuation and playlist continuation
- Cloudflare Quick Tunnel development workflow

## Safest upgrade from your working Phase 4.4 folder

Use this Phase 5 folder as a NEW folder. Do not delete the old working folder until Phase 5 is verified.

Copy these private/runtime items from your current Phase 4.4 folder into Phase 5:

    .env
    data/
    youtube_cookies.txt       (if you use it)
    cloudflared.exe
    runtime/                  (optional; otherwise yt-dlp is downloaded again)
    .audio-cache/             (optional, preserves already-cached songs)
    .ytjs-cache/              (optional)

Do NOT overwrite the new Phase 5 source files with old Phase 4.4 source files.

Then run:

    START_ACTIVITY_DEV.bat

The launcher now performs a clean Windows verification first. If `node_modules` is missing, incomplete, or came from another OS, it rebuilds dependencies for your PC, validates native Discord Voice/Rollup/esbuild/FFmpeg components, verifies yt-dlp, creates a fresh Vite production build, checks your `.env` variable names and SQLite integrity, and only then starts the single server on port 3001.

In a second window run:

    START_TUNNEL.bat

Copy the generated `trycloudflare.com` host into Discord Developer Portal -> Activities -> URL Mappings, just as before.

Finally run your bot launcher command once:

    !spawn

Phase 5 will best-effort delete the previous recorded launcher and post a new one at the bottom/current channel position.

## Default theme images

The four built-in slots look for:

    client/public/themes/theme-1.jpg
    client/public/themes/theme-2.jpg
    client/public/themes/theme-3.jpg
    client/public/themes/theme-4.jpg

Gradient fallbacks are built in, so the UI still works before you add your images. Replace those JPGs whenever you choose your final four defaults.

The `+` theme button is different: each user picks an image from their own computer. It is compressed in the Activity and stored locally for that Discord user; it is not broadcast to the server or other listeners.

## Optional cache settings

Defaults:

    AUDIO_CACHE_MAX_FILES=80
    AUDIO_CACHE_MAX_MB=512

You can add either variable to `.env` later. The cache removes the oldest files when either limit is exceeded.

## Validation

For the full preflight (recommended), run:

    VERIFY_PHASE5.bat

It validates the correct platform-native dependencies, JavaScript syntax, yt-dlp runtime, a fresh Vite production build, required `.env` variable names, and SQLite integrity.

For a quick source-only syntax pass, run:

    CHECK_PHASE5.bat

or:

    npm run check

## Important note about Spotify / YouTube reliability

Phase 5 is designed to resolve supported Spotify/YouTube music links quickly and with fallbacks, but no external media provider can be guaranteed to succeed 100% of the time: deleted/private/region-blocked media, provider changes, expired signatures, and network failures remain outside the Activity's control.

### Phase 5.4 search behavior

The search bar now behaves like a music browser rather than a command box. Pause briefly after typing three or more characters and matching tracks appear automatically. Pressing Enter only forces the current lookup to finish/show its matches; it never starts an arbitrary first match. Use the Play control on the result you actually want. Spotify and YouTube links follow the same explicit-result flow.
