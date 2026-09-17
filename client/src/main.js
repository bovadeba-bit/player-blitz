import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

window.__PLAYER_BOOTED__ = true;

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

const EMPTY_COVER =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="#372144"/>
          <stop offset=".48" stop-color="#161821"/>
          <stop offset="1" stop-color="#090a0e"/>
        </linearGradient>
        <radialGradient id="r">
          <stop stop-color="#9b66d8" stop-opacity=".46"/>
          <stop offset="1" stop-color="#9b66d8" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="900" height="900" fill="url(#g)"/>
      <circle cx="650" cy="210" r="360" fill="url(#r)"/>
      <path d="M115 615 C225 490 330 725 450 605 S655 485 790 595"
            fill="none" stroke="#ded9eb" stroke-opacity=".24" stroke-width="8"/>
      <text x="85" y="150" fill="#f3f1f7" font-family="Arial" font-size="50" font-weight="700">プレイヤー</text>
      <text x="90" y="215" fill="#8f8b9a" font-family="Arial" font-size="25">READY</text>
    </svg>
  `);

const BUILTIN_THEMES = ["theme-1", "theme-2", "theme-3", "theme-4"];
const actionTracks = new Map();
let globalClickBound = false;
let pendingRenderFrame = 0;
let appliedCustomBackground = "";

const state = {
  boot: "connecting",
  bootError: "",

  discordSdk: null,
  auth: null,
  sessionToken: "",
  guildId: "",
  instanceId: "",
  guild: null,
  me: null,

  members: [],
  libraries: new Map(),
  loadingLibraries: new Set(),
  libraryRequests: new Map(),
  selectedMemberId: "",
  memberSearch: "",
  expanded: new Set(),
  expandedPlaylists: new Set(),

  search: {
    query: "",
    mode: "normal",
    results: [],
    open: false,
    loading: false,
    playing: false,
    kind: "search",
    title: "",
    source: "",
    total: 0,
    sequence: 0,
    debounceTimer: null,
    abortController: null,
    clientCache: new Map(),
    composing: false,
    resetScroll: false,
  },

  addTarget: null,
  newPlaylistTargetKey: "",

  theme: {
    choice: "theme-1",
    custom: "",
  },

  feedback: null,
  feedbackTimer: null,

  player: {
    current: null,
    playing: false,
    positionMs: 0,
    history: [],
    playNext: [],
    baseQueue: [],
    baseKind: "none",
    radioFilling: false,
  },
  playerReceivedAt: Date.now(),

  voice: {
    connected: false,
    channelId: "",
    channelName: "",
    status: "idle",
  },

  socket: null,
  socketConnected: false,
  socketRetryTimer: null,
  socketRetryAttempt: 0,

  panelScroll: {
    workspace: 0,
    members: 0,
    queue: 0,
    search: 0,
  },
  userScrollingUntil: 0,
};

// ============================================================
// SMALL HELPERS
// ============================================================

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const norm = (value) => String(value ?? "").trim().toLowerCase();

function fmtMs(ms) {
  const safeSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function initials(name) {
  const parts = String(name || "?")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) return "?";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
}

function trackIdentityClient(track) {
  if (!track) return "";
  const youtube = String(track.youtubeUrl || "").split("&list=")[0].toLowerCase();
  if (youtube) return `yt:${youtube}`;
  const url = String(track.url || "").split("?si=")[0].toLowerCase();
  if (url) return `url:${url}`;
  return `meta:${norm(track.artist)}::${norm(track.title)}`;
}

function currentTrack() {
  return state.player?.current || null;
}

function currentPositionMs() {
  const player = state.player;
  if (!player?.current) return 0;

  let position = Number(player.positionMs || 0);

  if (player.playing) {
    position += Math.max(0, Date.now() - state.playerReceivedAt);
  }

  if (player.current.durationMs > 0) {
    position = Math.min(position, player.current.durationMs);
  }

  return position;
}

function getMember(id) {
  return state.members.find((member) => member.id === id) || null;
}

function getLibrary(userId) {
  return state.libraries.get(userId) || null;
}

function ownLibrary() {
  return state.me ? getLibrary(state.me.id) : null;
}

function selectedMember() {
  return getMember(state.selectedMemberId) || state.members[0] || null;
}

function isTrackLiked(track) {
  if (!track) return false;
  const identity = trackIdentityClient(track);
  const key = String(track.key || "");

  return Boolean(
    ownLibrary()?.liked?.some((liked) => {
      if (key && String(liked.key || "") === key) return true;
      return identity && trackIdentityClient(liked) === identity;
    })
  );
}

function trackCover(track) {
  const cover = String(track?.cover || "").trim();
  if (!cover) return EMPTY_COVER;
  return `/api/artwork?url=${encodeURIComponent(cover)}`;
}

function registerTrack(key, track) {
  actionTracks.set(String(key), track);
  return String(key);
}

function actionTrack(element) {
  return actionTracks.get(String(element?.dataset?.trackKey || "")) || null;
}

function connectionLabel() {
  if (state.feedback) return state.feedback.message;
  if (state.voice?.connected) return state.voice.channelName || "Voice connected";
  return state.socketConnected ? "Live sync" : "Reconnecting";
}

function updateConnectionUi() {
  const liveDot = document.querySelector(".library-panel .panel-title > i");
  liveDot?.classList.toggle("live", Boolean(state.socketConnected));

  const connection = document.querySelector(".connection-state");
  if (connection) {
    connection.querySelector("i")?.classList.toggle("online", Boolean(state.socketConnected));
    const label = connection.querySelector("span");
    if (label) label.textContent = connectionLabel();
  }

  document
    .querySelector(".center-stage")
    ?.classList.toggle(
      "preparing",
      state.voice?.status === "preparing" || state.voice?.status === "starting"
    );
}

function setFeedback(message, kind = "error", ttl = 6500) {
  clearTimeout(state.feedbackTimer);
  state.feedback = message ? { message: String(message), kind } : null;
  updateConnectionUi();

  if (state.feedback && ttl > 0) {
    state.feedbackTimer = setTimeout(() => {
      state.feedback = null;
      updateConnectionUi();
    }, ttl);
  }
}

function clearFeedback() {
  clearTimeout(state.feedbackTimer);
  state.feedback = null;
  updateConnectionUi();
}

function setPlayer(player) {
  if (!player) return;

  const previousIdentity = trackIdentityClient(state.player?.current);
  const nextIdentity = trackIdentityClient(player?.current);

  // Never let the bottom + picker keep targeting a song that has already
  // changed underneath it. This could otherwise add the previous track to a
  // newly created playlist after autoplay/another member advanced playback.
  if (previousIdentity !== nextIdentity && state.addTarget?.key === "current") {
    state.addTarget = null;
    state.newPlaylistTargetKey = "";
  }

  state.player = player;
  state.playerReceivedAt = Date.now();
}

function applyMemberCounts(userId, counts) {
  const member = getMember(userId);
  if (!member || !counts) return;

  member.likedCount = Number(counts.likedCount || 0);
  member.playlistCount = Number(counts.playlistCount || 0);
}

function setOwnLibrary(library, counts = null) {
  if (!state.me || !library) return;
  state.libraries.set(state.me.id, library);

  applyMemberCounts(
    state.me.id,
    counts || {
      likedCount: library.liked.length,
      playlistCount: library.playlists.length,
    }
  );
}

function getPlaylist(userId, playlistId) {
  return (
    getLibrary(userId)?.playlists?.find(
      (playlist) => Number(playlist.id) === Number(playlistId)
    ) || null
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  if (!active.id) return null;

  return {
    id: active.id,
    value: active.value,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreFocus(focus) {
  if (!focus?.id) return;
  const input = document.getElementById(focus.id);
  if (!(input instanceof HTMLInputElement)) return;

  // A full player render can be caused by a WebSocket/library/playback event
  // while somebody is typing. Preserve the live DOM value, not merely the
  // last value the application happened to render. This prevents cursor/value
  // jumps and scrambled queries when background state changes arrive.
  if (typeof focus.value === "string") {
    input.value = focus.value;
    if (focus.id === "music-query") state.search.query = focus.value;
    if (focus.id === "member-search") state.memberSearch = focus.value;
  }

  input.focus({ preventScroll: true });
  try {
    const max = input.value.length;
    input.setSelectionRange(
      Math.min(max, Number(focus.start ?? max)),
      Math.min(max, Number(focus.end ?? max))
    );
  } catch {}
}

// ============================================================
// AUTH + API
// ============================================================

async function createReadyDiscordSdk() {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sdk = new DiscordSDK(CLIENT_ID);

    try {
      await withTimeout(
        sdk.ready(),
        7000,
        `Discord Activity handshake (attempt ${attempt})`
      );
      return sdk;
    } catch (error) {
      lastError = error;
      console.warn(`[startup] SDK attempt ${attempt} failed:`, error);
      if (attempt < 3) await sleep(700 * attempt);
    }
  }

  throw lastError || new Error("Discord Activity handshake failed.");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (state.sessionToken) {
    headers.set("Authorization", `Bearer ${state.sessionToken}`);
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

async function authenticateActivity() {
  if (!CLIENT_ID) {
    throw new Error(
      "VITE_DISCORD_CLIENT_ID is missing. Put your Application/Client ID in .env."
    );
  }

  const discordSdk = await createReadyDiscordSdk();
  state.discordSdk = discordSdk;

  const { code } = await withTimeout(
    discordSdk.commands.authorize({
      client_id: CLIENT_ID,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "guilds"],
    }),
    10000,
    "Discord authorization"
  );

  const token = await withTimeout(
    api("/api/token", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
    10000,
    "Player session exchange"
  );

  state.sessionToken = token.session_token;

  state.auth = await withTimeout(
    discordSdk.commands.authenticate({
      access_token: token.access_token,
    }),
    10000,
    "Discord authentication"
  );

  if (!state.auth?.user) {
    throw new Error("Discord authenticate command returned no user.");
  }

  state.guildId = String(discordSdk.guildId || "");
  state.instanceId = String(discordSdk.instanceId || "");

  if (!state.guildId) {
    throw new Error(
      "Open プレイヤー from a server channel. Member libraries are server-scoped and do not run from DMs."
    );
  }

  const bootstrap = await api(
    `/api/bootstrap?guildId=${encodeURIComponent(state.guildId)}` +
      `&instanceId=${encodeURIComponent(state.instanceId)}`
  );

  state.me = bootstrap.me;
  state.guild = bootstrap.guild;
  state.members = Array.isArray(bootstrap.members) ? bootstrap.members : [];
  // Start with every member folder collapsed. Opening a member is an explicit
  // action; opening Liked Songs / Saved Playlists is a second explicit action.
  state.selectedMemberId = "";
  state.libraries.set(state.me.id, bootstrap.ownLibrary);
  setPlayer(bootstrap.player);
  if (bootstrap.voice) state.voice = bootstrap.voice;

  loadThemePreferences();

  state.boot = "ready";
  state.bootError = "";
  connectSharedSocket();
}

async function loadLibrary(userId, { force = false, quiet = false } = {}) {
  if (!force && state.libraries.has(userId)) {
    return state.libraries.get(userId);
  }

  // If two UI paths request the same member at once, await the existing fetch
  // instead of returning null. Returning null could leave an opened folder in
  // a permanent-looking Loading state when the original request was quiet.
  const pending = state.libraryRequests.get(userId);
  if (pending) {
    const value = await pending;
    if (!force) return value;
  }

  state.loadingLibraries.add(userId);
  if (!quiet) render();

  const request = (async () => {
    const result = await api(
      `/api/library/${encodeURIComponent(userId)}?guildId=${encodeURIComponent(state.guildId)}`
    );

    state.libraries.set(userId, result.library);
    applyMemberCounts(userId, {
      likedCount: result.library.liked.length,
      playlistCount: result.library.playlists.length,
    });

    return result.library;
  })();

  state.libraryRequests.set(userId, request);

  try {
    return await request;
  } finally {
    if (state.libraryRequests.get(userId) === request) {
      state.libraryRequests.delete(userId);
    }
    state.loadingLibraries.delete(userId);
    if (!quiet) render();
  }
}

// ============================================================
// WEBSOCKET SHARED STATE
// ============================================================

function clearSocketRetry() {
  if (state.socketRetryTimer) {
    clearTimeout(state.socketRetryTimer);
    state.socketRetryTimer = null;
  }
}

function scheduleSocketReconnect() {
  clearSocketRetry();
  if (state.boot !== "ready" || !state.sessionToken) return;

  // Back off on flaky mobile/tunnel connections instead of hammering the same
  // origin every 1.6 seconds forever. A successful connection resets this.
  const attempt = Math.min(5, state.socketRetryAttempt++);
  const base = Math.min(12_000, 1_200 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 350);

  state.socketRetryTimer = setTimeout(() => {
    connectSharedSocket();
  }, base + jitter);
}

function connectSharedSocket() {
  clearSocketRetry();

  try {
    state.socket?.close();
  } catch {}

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("session", state.sessionToken);
  url.searchParams.set("guildId", state.guildId);

  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.socketConnected = true;
    state.socketRetryAttempt = 0;
    updateConnectionUi();
  });

  socket.addEventListener("message", async (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "hello" || message.type === "player_state") {
      setPlayer(message.player);
      if (message.voice) state.voice = message.voice;
      scheduleRender();
      return;
    }

    if (message.type === "voice_status") {
      state.voice = message.voice || state.voice;
      updateConnectionUi();
      return;
    }

    if (message.type === "library_changed") {
      applyMemberCounts(message.userId, message.counts);

      const shouldRefresh =
        message.userId === state.selectedMemberId ||
        message.userId === state.me?.id;

      if (shouldRefresh) {
        try {
          await loadLibrary(message.userId, {
            force: true,
            quiet: true,
          });
        } catch (error) {
          console.warn("Library refresh failed:", error);
        }
      }

      render();
    }
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    state.socketConnected = false;

    if (event.code === 4401 || event.code === 4403) {
      state.boot = "error";
      state.bootError =
        "Your Activity session expired or is no longer authorized. Press Retry to reconnect with Discord.";
      render();
      return;
    }

    updateConnectionUi();
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket === socket) {
      state.socketConnected = false;
      updateConnectionUi();
    }
  });
}

// ============================================================
// PLAYER + LIBRARY ACTIONS
// ============================================================

async function playerAction(action, extra = {}) {
  const result = await api("/api/player/action", {
    method: "POST",
    body: JSON.stringify({
      guildId: state.guildId,
      action,
      ...extra,
    }),
  });

  setPlayer(result.player);
  render();
  return result.player;
}

async function playTrack(track) {
  if (!track) return;
  clearFeedback();
  await playerAction("play_single", { track });
}

async function addPlayNext(track) {
  if (!track) return;
  clearFeedback();
  await playerAction("play_next", { track });
}

async function playPlaylist(playlist, startIndex = 0) {
  if (!playlist?.tracks?.length) return;
  const index = Math.max(0, Math.min(playlist.tracks.length - 1, Number(startIndex) || 0));
  clearFeedback();
  await playerAction("play_collection", {
    tracks: playlist.tracks.slice(index),
  });
}

async function toggleTrackLike(track) {
  if (!track) return;

  const result = await api("/api/library/likes/toggle", {
    method: "POST",
    body: JSON.stringify({
      guildId: state.guildId,
      track,
    }),
  });

  setOwnLibrary(result.library, result.counts);
  render();
}

async function createOwnPlaylist(name, track = null) {
  const result = await api("/api/library/playlists", {
    method: "POST",
    body: JSON.stringify({
      guildId: state.guildId,
      name,
      track,
    }),
  });

  setOwnLibrary(result.library, result.counts);
  state.newPlaylistTargetKey = "";
  state.addTarget = null;
  render();
}

async function deleteOwnPlaylist(playlistId) {
  const result = await api(
    `/api/library/playlists/${encodeURIComponent(playlistId)}` +
      `?guildId=${encodeURIComponent(state.guildId)}`,
    { method: "DELETE" }
  );

  setOwnLibrary(result.library, result.counts);
  state.expandedPlaylists.delete(`${state.me.id}:${playlistId}`);
  render();
}

async function addTrackToPlaylist(playlistId, track) {
  if (!track) return;

  const result = await api(
    `/api/library/playlists/${encodeURIComponent(playlistId)}/tracks`,
    {
      method: "POST",
      body: JSON.stringify({
        guildId: state.guildId,
        track,
      }),
    }
  );

  setOwnLibrary(result.library, result.counts);
  state.addTarget = null;
  state.newPlaylistTargetKey = "";
  render();
}

async function removeOwnPlaylistTrack(playlistId, trackKey) {
  const result = await api(
    `/api/library/playlists/${encodeURIComponent(playlistId)}` +
      `/tracks/${encodeURIComponent(trackKey)}` +
      `?guildId=${encodeURIComponent(state.guildId)}`,
    { method: "DELETE" }
  );

  setOwnLibrary(result.library, result.counts);
  render();
}

// ============================================================
// SEARCH — INDEPENDENT FROM PLAYBACK STATE
// ============================================================

function clearSearchTimer() {
  if (state.search.debounceTimer) {
    clearTimeout(state.search.debounceTimer);
    state.search.debounceTimer = null;
  }
}

function cancelSearchRequest() {
  try {
    state.search.abortController?.abort();
  } catch {}
  state.search.abortController = null;
}

function searchCacheKey(query, mode) {
  return `${mode}:${norm(query)}`;
}

function readClientSearchCache(query, mode) {
  const key = searchCacheKey(query, mode);
  const cached = state.search.clientCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    state.search.clientCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeClientSearchCache(query, mode, value) {
  const key = searchCacheKey(query, mode);
  state.search.clientCache.set(key, {
    value,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  // Keep this tiny. It is only a UI accelerator, not the canonical cache.
  if (state.search.clientCache.size > 60) {
    const oldest = state.search.clientCache.keys().next().value;
    if (oldest) state.search.clientCache.delete(oldest);
  }
}

function searchShouldRun(query) {
  const value = String(query || "").trim();
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  // Two-character live searches created too much provider churn for very little
  // useful signal. Three characters still feels immediate while eliminating a
  // large chunk of throw-away requests on Discord mobile/low-power clients.
  return value.length >= 3;
}

function scheduleSearch() {
  clearSearchTimer();
  const query = state.search.query.trim();

  // Every keystroke invalidates the previous browser request. More importantly,
  // we DO NOT rebuild the dropdown or start an animation on every keypress.
  // That was still enough work to make Chromium/Discord hitch while typing.
  state.search.sequence += 1;
  cancelSearchRequest();

  if (!searchShouldRun(query)) {
    state.search.results = [];
    state.search.loading = false;
    state.search.open = false;
    updateSearchUi();
    return;
  }

  const cached = readClientSearchCache(query, state.search.mode);
  if (cached) {
    applySearchResult(cached);
    state.search.loading = false;
    state.search.open = true;
    updateSearchUi();
    return;
  }

  // Keep any already-visible results in place while the user is still typing.
  // The expensive result-list DOM is updated only when a real request begins or
  // completes, not once per character.
  state.search.loading = false;

  // Fast enough to feel like autocomplete, while still avoiding a provider
  // request for every individual keystroke. Links can resolve almost
  // immediately because paste is typically a single input event.
  const delay = /^https?:\/\//i.test(query) ? 90 : 300;
  state.search.debounceTimer = setTimeout(() => {
    state.search.debounceTimer = null;
    // The query/mode may have changed while the timer was waiting.
    if (query !== state.search.query.trim()) return;
    runSearch(query, state.search.mode).catch((error) => {
      if (error?.name === "AbortError") return;
      console.error("Search failed:", error);
    });
  }, delay);
}

async function forceSearchNow() {
  clearSearchTimer();
  cancelSearchRequest();

  const query = state.search.query.trim();
  if (!searchShouldRun(query)) {
    state.search.results = [];
    state.search.loading = false;
    state.search.open = Boolean(query);
    updateSearchUi();
    return;
  }

  const cached = readClientSearchCache(query, state.search.mode);
  if (cached) {
    applySearchResult(cached);
    state.search.loading = false;
    state.search.open = true;
    updateSearchUi();
    return;
  }

  await runSearch(query, state.search.mode);
}

function applySearchResult(result) {
  state.search.results = Array.isArray(result?.results) ? result.results : [];
  state.search.kind = result?.kind || "search";
  state.search.title = result?.title || "";
  state.search.source = result?.source || "";
  state.search.total = Number(result?.total || state.search.results.length);
}

async function runSearch(query, mode) {
  const sequence = ++state.search.sequence;
  const controller = new AbortController();
  state.search.abortController = controller;
  state.search.loading = true;
  state.search.open = true;
  updateSearchUi();

  try {
    const result = await api("/api/music/search", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        guildId: state.guildId,
        query,
        mode,
      }),
    });

    if (sequence !== state.search.sequence) return;
    if (query !== state.search.query.trim() || mode !== state.search.mode) return;

    applySearchResult(result);
    writeClientSearchCache(query, mode, result);
    state.search.loading = false;
    state.search.open = true;
    updateSearchUi();
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (sequence !== state.search.sequence) return;
    state.search.loading = false;
    state.search.results = [];
    state.search.open = true;
    updateSearchUi();
    setFeedback(error.message || "Search failed.", "error");
  } finally {
    if (state.search.abortController === controller) {
      state.search.abortController = null;
    }
  }
}

// ============================================================
// THEMES — LOCAL/PER USER
// ============================================================

function themeKey(name) {
  return `player:${state.me?.id || "anonymous"}:${name}`;
}

function loadThemePreferences() {
  try {
    const choice = localStorage.getItem(themeKey("theme-choice"));
    const custom = localStorage.getItem(themeKey("theme-custom"));

    if (choice === "custom" || BUILTIN_THEMES.includes(choice)) {
      state.theme.choice = choice;
    }
    state.theme.custom = custom || "";

    if (state.theme.choice === "custom" && !state.theme.custom) {
      state.theme.choice = "theme-1";
    }
  } catch {}
}

function saveThemeChoice(choice) {
  state.theme.choice = choice;
  try {
    localStorage.setItem(themeKey("theme-choice"), choice);
  } catch {}
  render();
}

function applyThemeToDom() {
  const app = document.querySelector("#app");
  if (!app) return;

  // #app survives every player render. Keep the potentially multi-megabyte
  // custom image CSS value there so track/queue updates do not repeatedly
  // parse and assign the same base64 image on constrained mobile clients.
  if (state.theme.custom !== appliedCustomBackground) {
    appliedCustomBackground = state.theme.custom;
    if (state.theme.custom) {
      app.style.setProperty(
        "--player-custom-background",
        `url(${JSON.stringify(state.theme.custom)})`
      );
    } else {
      app.style.removeProperty("--player-custom-background");
    }
  }

  const customPreview = document.querySelector("#theme-custom");
  if (customPreview && state.theme.custom) {
    customPreview.style.backgroundImage = "var(--player-custom-background)";
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be read."));
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("That image could not be encoded."));
    reader.readAsDataURL(blob);
  });
}

async function compressBackground(file) {
  if (!file?.type?.startsWith("image/")) {
    throw new Error("Choose an image file for the background.");
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(objectUrl);
    const constrained =
      matchMedia("(max-width: 900px), (pointer: coarse)").matches;
    const maxWidth = constrained ? 1440 : 1920;
    const maxHeight = constrained ? 900 : 1080;
    const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Your Discord client could not prepare that image.");

    context.drawImage(image, 0, 0, width, height);

    // toBlob performs the costly image encoding asynchronously in Chromium.
    // The previous toDataURL loop was synchronous and could freeze a phone for
    // noticeable stretches when a large wallpaper was selected.
    let quality = 0.86;
    let blob = await canvasToBlob(canvas, "image/webp", quality);
    while (blob && blob.size > 2_700_000 && quality > 0.46) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, "image/webp", quality);
    }

    let data;
    if (blob) {
      data = await blobToDataUrl(blob);
    } else {
      // Very old/odd Chromium fallback. Discord's current clients support
      // WebP canvas encoding, but retain a safe path rather than failing.
      data = canvas.toDataURL("image/jpeg", 0.78);
    }

    if (data.length > 4_500_000) {
      throw new Error("That image is still too large after optimization. Try a smaller image.");
    }

    return data;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function acceptCustomBackground(file) {
  const data = await compressBackground(file);
  state.theme.custom = data;
  state.theme.choice = "custom";

  try {
    localStorage.setItem(themeKey("theme-custom"), data);
    localStorage.setItem(themeKey("theme-choice"), "custom");
  } catch {
    throw new Error("Discord could not save that background locally. Try a smaller image.");
  }

  render();
}

// ============================================================
// UI STATE PRESERVATION
// ============================================================

function capturePanelScroll() {
  const workspace = document.querySelector(".workspace");
  const members = document.querySelector(".member-scroll");
  const queue = document.querySelector(".queue-scroll");
  const search = document.querySelector(".search-results-list");

  // On mobile the *workspace itself* is the primary page scroller. RC3 only
  // remembered the two inner panel scrollports, so any player-state render
  // recreated .workspace at scrollTop=0 and threw the user back to the cover.
  if (workspace) state.panelScroll.workspace = workspace.scrollTop;
  if (members) state.panelScroll.members = members.scrollTop;
  if (queue) state.panelScroll.queue = queue.scrollTop;
  if (search && !state.search.resetScroll) state.panelScroll.search = search.scrollTop;
}

function restorePanelScroll() {
  const restore = (onlyIfReset = false) => {
    const entries = [
      [document.querySelector(".workspace"), state.panelScroll.workspace],
      [document.querySelector(".member-scroll"), state.panelScroll.members],
      [document.querySelector(".queue-scroll"), state.panelScroll.queue],
      [document.querySelector(".search-results-list"), state.panelScroll.search],
    ];

    for (const [element, value] of entries) {
      if (!element) continue;
      const saved = Math.max(0, Number(value || 0));
      if (onlyIfReset && saved > 2 && element.scrollTop > 2) continue;
      element.scrollTop = saved;
    }
  };

  restore(false);

  // Re-apply once after layout only if Chromium actually snapped the new
  // element back near zero. Do not fight a real user gesture that happened
  // during the frame immediately after rendering.
  requestAnimationFrame(() => restore(true));
}

function scheduleRender() {
  if (pendingRenderFrame) return;

  const attempt = () => {
    pendingRenderFrame = 0;

    // A remote track/voice update is allowed to wait a fraction of a second
    // while somebody is actively flick-scrolling on mobile. Replacing a large
    // DOM subtree mid-gesture is one of the easiest ways to kill momentum and
    // make the Activity feel like it "jumped" even when scrollTop is restored.
    if (performance.now() < state.userScrollingUntil) {
      pendingRenderFrame = requestAnimationFrame(attempt);
      return;
    }

    render();
  };

  pendingRenderFrame = requestAnimationFrame(attempt);
}

// ============================================================
// MARKUP
// ============================================================

function avatarMarkup(member) {
  if (member?.avatarUrl) {
    return `
      <span class="avatar">
        <img src="${esc(member.avatarUrl)}" alt="" loading="lazy" decoding="async" />
      </span>
    `;
  }

  return `<span class="avatar">${esc(initials(member?.name))}</span>`;
}

function playlistPickerMarkup(key, track, placement = "inline") {
  if (!state.addTarget || state.addTarget.key !== key) return "";

  const playlists = ownLibrary()?.playlists || [];
  const creating = state.newPlaylistTargetKey === key;

  return `
    <div class="playlist-picker ${placement === "bottom" ? "bottom-picker" : ""}">
      <div class="picker-title">Add to playlist</div>
      <div class="picker-list">
        ${
          playlists.length
            ? playlists
                .map(
                  (playlist) => `
                    <button class="picker-playlist"
                            data-playlist="${playlist.id}"
                            data-track-key="${esc(registerTrack(`${key}:picker:${playlist.id}`, track))}">
                      <span>▣</span>
                      <strong>${esc(playlist.name)}</strong>
                    </button>
                  `
                )
                .join("")
            : `<div class="picker-empty">No playlists yet</div>`
        }
      </div>
      ${
        creating
          ? `<form class="picker-new-form" data-target-key="${esc(key)}">
              <input class="picker-new-name"
                     maxlength="80"
                     autocomplete="off"
                     placeholder="Playlist name" />
              <button type="submit">Create</button>
            </form>`
          : `<button class="picker-new" data-target-key="${esc(key)}">＋ New playlist</button>`
      }
    </div>
  `;
}

function compactTrackActions(track, key, options = {}) {
  const registered = registerTrack(key, track);
  const liked = isTrackLiked(track);

  return `
    <div class="micro-actions">
      ${
        options.playClass
          ? `<button class="micro ${options.playClass}"
                     ${options.playData || ""}
                     data-track-key="${esc(registered)}"
                     title="Play now">▶</button>`
          : `<button class="micro action-play" data-track-key="${esc(registered)}" title="Play now">▶</button>`
      }
      <button class="micro action-next" data-track-key="${esc(registered)}" title="Play next">↥</button>
      <button class="micro action-like ${liked ? "liked" : ""}"
              data-track-key="${esc(registered)}"
              title="${liked ? "Unlike" : "Like"}">${liked ? "♥" : "♡"}</button>
      <button class="micro action-add" data-track-key="${esc(registered)}" title="Add to playlist">＋</button>
      ${
        options.removeClass
          ? `<button class="micro danger ${options.removeClass}"
                     ${options.removeData || ""}
                     data-track-key="${esc(registered)}"
                     title="Remove">×</button>`
          : ""
      }
    </div>
  `;
}

function libraryTrack(track, member, index) {
  const key = `liked:${member.id}:${index}`;
  const owner = member.id === state.me.id;

  return `
    <div class="library-track-wrap">
      <div class="library-track">
        <img class="mini-cover" src="${esc(trackCover(track))}" alt="" loading="lazy" decoding="async" />
        <div class="track-copy">
          <strong>${esc(track.title)}</strong>
          <span>${esc(track.artist || "Unknown artist")}</span>
        </div>
        ${compactTrackActions(track, key)}
        ${
          owner
            ? `<button class="library-delete liked-delete"
                       data-track-key="${esc(registerTrack(`${key}:delete`, track))}"
                       title="Delete from Liked Songs">×</button>`
            : ""
        }
      </div>
      ${playlistPickerMarkup(key, track)}
    </div>
  `;
}

function playlistView(playlist, member) {
  const key = `${member.id}:${playlist.id}`;
  const open = state.expandedPlaylists.has(key);
  const owner = member.id === state.me.id;

  return `
    <div class="playlist-card">
      <div class="playlist-head">
        <button class="folder-row playlist-toggle"
                data-member="${member.id}"
                data-playlist="${playlist.id}">
          <span class="chevron">${open ? "⌄" : "›"}</span>
          <span class="folder-glyph">▤</span>
          <span class="folder-copy">
            <strong>${esc(playlist.name)}</strong>
            <small>${playlist.tracks.length} songs</small>
          </span>
        </button>

        <div class="micro-actions always-on-small">
          <button class="micro playlist-play"
                  data-member="${member.id}"
                  data-playlist="${playlist.id}"
                  title="Play playlist">▶</button>
          ${
            owner
              ? `<button class="micro danger playlist-delete"
                         data-playlist="${playlist.id}"
                         title="Delete playlist">×</button>`
              : ""
          }
        </div>
      </div>

      ${
        open
          ? `<div class="playlist-tracks">
              ${
                playlist.tracks.length
                  ? playlist.tracks
                      .map((track, trackIndex) => {
                        const trackKey = `playlist:${member.id}:${playlist.id}:${trackIndex}`;
                        return `
                          <div class="library-track-wrap">
                            <div class="library-track nested">
                              <img class="mini-cover" src="${esc(trackCover(track))}" alt="" loading="lazy" decoding="async" />
                              <div class="track-copy">
                                <strong>${esc(track.title)}</strong>
                                <span>${esc(track.artist || "Unknown artist")}</span>
                              </div>
                              ${compactTrackActions(track, trackKey, {
                                playClass: "playlist-track-play",
                                playData:
                                  `data-member="${member.id}" ` +
                                  `data-playlist="${playlist.id}" ` +
                                  `data-track-index="${trackIndex}"`,
                                removeClass: owner ? "playlist-track-remove" : "",
                                removeData: owner
                                  ? `data-playlist="${playlist.id}" data-track-db-key="${esc(track.key || "")}"`
                                  : "",
                              })}
                            </div>
                            ${playlistPickerMarkup(trackKey, track)}
                          </div>
                        `;
                      })
                      .join("")
                  : `<div class="empty left tiny-empty">Empty playlist</div>`
              }
            </div>`
          : ""
      }
    </div>
  `;
}

function memberView(member) {
  const active = member.id === state.selectedMemberId;
  const owner = member.id === state.me.id;
  const library = getLibrary(member.id);
  const loading = state.loadingLibraries.has(member.id);

  const liked = library?.liked || [];
  const playlists = library?.playlists || [];

  const likedCount = library ? liked.length : Number(member.likedCount || 0);
  const playlistCount = library
    ? playlists.length
    : Number(member.playlistCount || 0);

  const likedKey = `${member.id}:liked`;
  const playlistsKey = `${member.id}:playlists`;

  return `
    <article class="member ${active ? "active" : ""}">
      <button class="member-head" data-member-select="${member.id}">
        ${avatarMarkup(member)}
        <span class="member-copy">
          <strong>
            ${esc(member.name)}
            ${owner ? `<em class="you-tag">YOU</em>` : ""}
          </strong>
          <small>${likedCount} liked • ${playlistCount} playlists</small>
        </span>
        <span class="chevron member-chevron">${active ? "⌄" : "›"}</span>
      </button>

      ${
        active
          ? `<div class="folders">
              <button class="folder-row section-toggle" data-section="${likedKey}">
                <span class="chevron">${state.expanded.has(likedKey) ? "⌄" : "›"}</span>
                <span class="folder-glyph">♥</span>
                <span class="folder-copy">
                  <strong>Liked Songs</strong>
                  <small>${likedCount} songs</small>
                </span>
              </button>

              ${
                state.expanded.has(likedKey)
                  ? `<div class="folder-content">
                      ${
                        loading && !library
                          ? `<div class="empty left tiny-empty">Loading…</div>`
                          : liked.length
                            ? liked.map((track, index) => libraryTrack(track, member, index)).join("")
                            : `<div class="empty left tiny-empty">No liked songs yet</div>`
                      }
                    </div>`
                  : ""
              }

              <button class="folder-row section-toggle" data-section="${playlistsKey}">
                <span class="chevron">${state.expanded.has(playlistsKey) ? "⌄" : "›"}</span>
                <span class="folder-glyph">▣</span>
                <span class="folder-copy">
                  <strong>Saved Playlists</strong>
                  <small>${playlistCount} playlists</small>
                </span>
              </button>

              ${
                state.expanded.has(playlistsKey)
                  ? `<div class="folder-content">
                      ${
                        loading && !library
                          ? `<div class="empty left tiny-empty">Loading…</div>`
                          : playlists.length
                            ? playlists.map((playlist) => playlistView(playlist, member)).join("")
                            : `<div class="empty left tiny-empty">No saved playlists yet</div>`
                      }
                    </div>`
                  : ""
              }
            </div>`
          : ""
      }
    </article>
  `;
}

function queueRow(item, index, priority) {
  const key = `queue:${priority ? "priority" : "base"}:${index}`;
  const registered = registerTrack(key, item);
  const liked = isTrackLiked(item);

  return `
    <div class="queue-row ${priority ? "priority" : ""}">
      <img class="queue-cover" src="${esc(trackCover(item))}" alt="" loading="lazy" decoding="async" />

      <div class="queue-copy">
        <strong>${esc(item.title)}</strong>
        <span>${esc(item.artist || "Unknown artist")}</span>
        ${priority ? `<em>PLAY NEXT</em>` : ""}
      </div>

      <button class="queue-like ${liked ? "liked" : ""}"
              data-track-key="${esc(registered)}"
              title="${liked ? "Unlike" : "Like"}">${liked ? "♥" : "♡"}</button>

      <button class="queue-play"
              data-kind="${priority ? "priority" : "base"}"
              data-index="${index}"
              title="Play now">▶</button>

      <button class="queue-remove"
              data-kind="${priority ? "priority" : "base"}"
              data-index="${index}"
              title="Remove">×</button>
    </div>
  `;
}

function searchResultRow(track, index) {
  const key = `search:${index}`;
  const registered = registerTrack(key, track);
  const liked = isTrackLiked(track);
  const duration = Number(track.durationMs || 0);

  return `
    <div class="search-result-wrap">
      <div class="search-result">
        <img src="${esc(trackCover(track))}" alt="" loading="lazy" decoding="async" />
        <div class="search-result-copy">
          <strong>${esc(track.title)}</strong>
          <span>${esc(track.artist || "Unknown artist")}${duration ? ` • ${fmtMs(duration)}` : ""}</span>
        </div>
        <div class="search-result-actions">
          <button class="search-play action-play" data-track-key="${esc(registered)}" title="Play now">▶</button>
          <button class="action-next" data-track-key="${esc(registered)}" title="Play next">↥</button>
          <button class="action-like ${liked ? "liked" : ""}"
                  data-track-key="${esc(registered)}"
                  title="${liked ? "Unlike" : "Like"}">${liked ? "♥" : "♡"}</button>
          <button class="action-add" data-track-key="${esc(registered)}" title="Add to playlist">＋</button>
        </div>
      </div>
      ${playlistPickerMarkup(key, track)}
    </div>
  `;
}

function searchDropdownMarkup() {
  if (!state.search.open) return "";

  const hasResults = state.search.results.length > 0;
  const collection = state.search.kind === "playlist";

  return `
    <div class="search-dropdown">
      <div class="search-dropdown-head">
        <span>${
          collection
            ? `${esc(state.search.source || "collection")} • ${state.search.total} tracks`
            : state.search.mode === "slow"
              ? "SLOWED + REVERB"
              : state.search.mode === "fast"
                ? "SPED UP"
                : "SONGS"
        }</span>
        ${collection && state.search.title ? `<strong>${esc(state.search.title)}</strong>` : ""}
      </div>
      <div class="search-results-list">
        ${
          state.search.loading && !hasResults
            ? `<div class="search-loading"><i></i><i></i><i></i></div>`
            : hasResults
              ? state.search.results.map(searchResultRow).join("")
              : `<div class="search-empty">No matching music found</div>`
        }
      </div>
    </div>
  `;
}

// Search is intentionally an isolated UI island. Rebuilding the entire
// Activity on each lookup was expensive when libraries/queue artwork were
// present and could make typing feel frozen inside Discord. This updater only
// touches the search shell + dropdown and leaves the rest of the DOM alone.
function updateSearchUi() {
  const zone = document.querySelector("#search-zone");
  if (!zone) return;

  const oldResults = zone.querySelector(".search-results-list");
  if (state.search.resetScroll) {
    state.panelScroll.search = 0;
  } else if (oldResults) {
    state.panelScroll.search = oldResults.scrollTop;
  }

  const shell = zone.querySelector(".search-shell");
  shell?.classList.toggle("resolving", Boolean(state.search.loading));

  const input = zone.querySelector("#music-query");
  if (
    input instanceof HTMLInputElement &&
    document.activeElement !== input &&
    input.value !== state.search.query
  ) {
    input.value = state.search.query;
  }

  const submit = zone.querySelector(".search-submit");
  if (submit) submit.textContent = state.search.loading ? "…" : "⌕";

  zone.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("on", button.dataset.mode === state.search.mode);
  });

  zone.querySelector(".search-dropdown")?.remove();
  const dropdown = searchDropdownMarkup();
  if (dropdown) zone.insertAdjacentHTML("beforeend", dropdown);

  const newResults = zone.querySelector(".search-results-list");
  if (newResults) newResults.scrollTop = state.panelScroll.search;
  state.search.resetScroll = false;

  zone
    .querySelectorAll(".search-dropdown img")
    .forEach((image) => {
      image.addEventListener("error", (event) => {
        if (event.currentTarget.src !== EMPTY_COVER) {
          event.currentTarget.src = EMPTY_COVER;
        }
      });
    });
}

function themeStripMarkup() {
  return `
    <div class="theme-strip">
      <input id="theme-file" type="file" accept="image/*" hidden />
      <button class="theme-add" id="theme-add" title="Use your own background">＋</button>
      ${BUILTIN_THEMES.map(
        (theme, index) => `
          <button class="theme-swatch ${theme} ${state.theme.choice === theme ? "active" : ""}"
                  data-theme="${theme}"
                  title="Theme ${index + 1}">
            <span>${index + 1}</span>
          </button>
        `
      ).join("")}
      ${
        state.theme.custom
          ? `<button class="theme-swatch custom-preview ${state.theme.choice === "custom" ? "active" : ""}"
                     id="theme-custom"
                     title="Your background"><span>★</span></button>`
          : ""
      }
    </div>
  `;
}

function bootMarkup() {
  const failed = state.boot === "error";

  return `
    <main class="boot-screen">
      <div class="boot-card">
        <span class="brand-mark large">プ</span>
        <h1>プレイヤー</h1>
        <p>
          ${
            failed
              ? esc(state.bootError)
              : "Connecting Discord, libraries, search, and voice…"
          }
        </p>
        ${
          failed
            ? `<button id="retry-boot" class="retry-button">Retry</button>`
            : `<div class="boot-loader"><i></i><i></i><i></i></div>`
        }
      </div>
    </main>
  `;
}

function render() {
  if (pendingRenderFrame) {
    cancelAnimationFrame(pendingRenderFrame);
    pendingRenderFrame = 0;
  }

  const app = document.querySelector("#app");
  if (!app) return;

  const focus = captureFocus();

  if (state.boot === "ready") {
    capturePanelScroll();
  }

  if (state.boot !== "ready") {
    app.innerHTML = bootMarkup();
    document.querySelector("#retry-boot")?.addEventListener("click", () => start());
    return;
  }

  actionTracks.clear();

  const memberQuery = norm(state.memberSearch);
  const filtered = state.members.filter(
    (member) =>
      !memberQuery ||
      norm(member.name).includes(memberQuery) ||
      norm(member.username).includes(memberQuery)
  );

  const current = currentTrack();
  const positionMs = currentPositionMs();
  const durationMs = Number(current?.durationMs || 0);
  const progress =
    durationMs > 0 ? Math.min(100, Math.max(0, (positionMs / durationMs) * 100)) : 0;
  const currentLiked = isTrackLiked(current);
  const currentKey = current ? registerTrack("current", current) : "";

  app.innerHTML = `
    <main class="app-shell ${state.theme.choice === "custom" && state.theme.custom ? "custom-background-active" : ""}">
      <div class="user-background ${state.theme.choice === "custom" && state.theme.custom ? "custom-theme" : esc(state.theme.choice || "theme-1")}"></div>
      <div class="background-shade"></div>

      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">プ</span>
          <div>
            <strong>プレイヤー</strong>
            <small>${esc(state.guild?.name || "shared music")}</small>
          </div>
        </div>

        <div id="search-zone" class="search-zone">
          <div class="search-shell ${state.search.loading ? "resolving" : ""}">
            <form id="music-search" class="music-search" autocomplete="off">
              <span class="magnify">⌕</span>
              <input id="music-query"
                     autocomplete="off"
                     autocapitalize="none"
                     autocorrect="off"
                     spellcheck="false"
                     enterkeyhint="search"
                     name="player-music-query"
                     placeholder="Search a song or paste a Spotify / YouTube link"
                     value="${esc(state.search.query)}" />
              <button type="submit" class="search-submit" title="Show search results">
                ${state.search.loading ? "…" : "⌕"}
              </button>
            </form>

            <div class="search-modes">
              <button type="button"
                      data-mode="slow"
                      class="${state.search.mode === "slow" ? "on" : ""}">
                Slowed + reverb
              </button>
              <button type="button"
                      data-mode="fast"
                      class="${state.search.mode === "fast" ? "on" : ""}">
                Sped up
              </button>
            </div>
          </div>
          ${searchDropdownMarkup()}
        </div>
      </header>

      <section class="workspace">
        <aside class="library-panel panel">
          <div class="panel-title">
            <div>
              <span>LIBRARY</span>
              <h2>Members</h2>
            </div>
            <i class="${state.socketConnected ? "live" : ""}"></i>
          </div>

          <label class="member-search">
            <span>⌕</span>
            <input id="member-search"
                   autocomplete="off"
                   placeholder="Search members"
                   value="${esc(state.memberSearch)}" />
          </label>

          <div class="member-scroll">
            ${
              filtered.length
                ? filtered.map(memberView).join("")
                : `<div class="empty">No matching member</div>`
            }
          </div>

          ${themeStripMarkup()}
        </aside>

        <section class="center-stage ${state.voice?.status === "preparing" || state.voice?.status === "starting" ? "preparing" : ""}">
          <div class="cover-haze"></div>
          <div class="cover ${current ? "" : "empty-cover"}">
            <img src="${esc(trackCover(current))}" alt="" decoding="async" fetchpriority="high" />
          </div>
        </section>

        <aside class="queue-panel panel">
          <div class="panel-title">
            <div>
              <span>UP NEXT</span>
              <h2>Queue</h2>
            </div>
            <b>${state.player.playNext.length + state.player.baseQueue.length}</b>
          </div>

          <div class="queue-scroll">
            ${
              state.player.playNext.length
                ? `<div class="queue-group">
                    <div class="queue-group-title">
                      <strong>Play next</strong>
                      <span>priority</span>
                    </div>
                    ${state.player.playNext.map((track, index) => queueRow(track, index, true)).join("")}
                  </div>`
                : ""
            }

            <div class="queue-group">
              <div class="queue-group-title">
                <strong>${
                  state.player.baseKind === "playlist"
                    ? "Playlist"
                    : state.player.baseKind === "radio"
                      ? "Similar"
                      : "Continue"
                }</strong>
                <span>${
                  state.player.baseKind === "playlist"
                    ? "playlist"
                    : state.player.baseKind === "radio"
                      ? "autoplay"
                      : "queue"
                }</span>
              </div>

              ${
                state.player.baseQueue.length
                  ? state.player.baseQueue.map((track, index) => queueRow(track, index, false)).join("")
                  : state.player.radioFilling
                    ? `<div class="queue-skeleton"><i></i><i></i><i></i></div>`
                    : `<div class="empty left">${
                        current
                          ? "No more tracks are queued yet."
                          : "Play a song or playlist to begin."
                      }</div>`
              }
            </div>
          </div>
        </aside>
      </section>

      <footer class="playerbar">
        <div class="timeline-line">
          <span>${fmtMs(positionMs)}</span>
          <input id="timeline-seek"
                 class="timeline-seek"
                 type="range"
                 min="0"
                 max="${Math.max(1, durationMs)}"
                 step="250"
                 value="${Math.min(positionMs, Math.max(1, durationMs))}"
                 style="--seek-progress:${progress}%"
                 aria-label="Seek through current song"
                 ${current && durationMs > 0 ? "" : "disabled"} />
          <span>${durationMs > 0 ? fmtMs(durationMs) : "0:00"}</span>
        </div>

        <div class="transport-row">
          <div class="connection-state">
            <i class="${state.socketConnected ? "online" : ""}"></i>
            <span>${
              esc(connectionLabel())
            }</span>
          </div>

          <div class="transport">
            <button id="previous" ${current ? "" : "disabled"} title="Previous">│◀</button>
            <button id="pause" class="main-play" ${current ? "" : "disabled"} title="Play / pause">
              ${state.player.playing ? "Ⅱ" : "▶"}
            </button>
            <button id="next" ${current ? "" : "disabled"} title="Next">▶│</button>
          </div>

          <div class="current-meta">
            <div class="current-copy">
              <strong>${esc(current?.title || "Nothing playing")}</strong>
              <span>${esc(current?.artist || "Ready when you are")}</span>
            </div>

            <button id="heart"
                    class="${currentLiked ? "liked" : ""}"
                    data-track-key="${esc(currentKey)}"
                    ${current ? "" : "disabled"}
                    title="${currentLiked ? "Unlike" : "Like"}">
              ${currentLiked ? "♥" : "♡"}
            </button>

            <div class="bottom-add-wrap">
              <button id="add"
                      data-track-key="${esc(currentKey)}"
                      ${current ? "" : "disabled"}
                      title="Add to playlist">＋</button>
              ${current ? playlistPickerMarkup("current", current, "bottom") : ""}
            </div>
          </div>
        </div>
      </footer>
    </main>
  `;

  bind();
  restorePanelScroll();
  applyThemeToDom();
  restoreFocus(focus);
}

// ============================================================
// INTERACTIONS
// ============================================================

function bindAsync(selector, eventName, handler) {
  document.querySelectorAll(selector).forEach((element) => {
    element.addEventListener(eventName, async (event) => {
      try {
        await handler(event, element);
      } catch (error) {
        console.error(error);
        setFeedback(error.message || "Action failed", "error");
      }
    });
  });
}

function openAddTarget(key, track) {
  if (!track) return;

  if (state.addTarget?.key === key) {
    state.addTarget = null;
    state.newPlaylistTargetKey = "";
  } else {
    state.addTarget = { key, track };
    state.newPlaylistTargetKey = "";
  }

  render();
}

function bind() {
  document
    .querySelectorAll(".mini-cover, .queue-cover, .search-result img, .cover img")
    .forEach((image) => {
      image.addEventListener("error", (event) => {
        if (event.currentTarget.src !== EMPTY_COVER) {
          event.currentTarget.src = EMPTY_COVER;
        }
      });
    });

  document
    .querySelectorAll(".workspace, .member-scroll, .queue-scroll, .search-results-list")
    .forEach((scroller) => {
      scroller.addEventListener(
        "scroll",
        () => {
          state.userScrollingUntil = performance.now() + 140;
        },
        { passive: true }
      );
    });

  const musicInput = document.querySelector("#music-query");
  musicInput?.addEventListener("input", (event) => {
    const nextQuery = event.target.value;
    if (nextQuery !== state.search.query) {
      state.panelScroll.search = 0;
      state.search.resetScroll = true;
    }
    state.search.query = nextQuery;
    state.search.open = Boolean(nextQuery.trim());
    if (!state.search.composing) scheduleSearch();
  });

  musicInput?.addEventListener("compositionstart", () => {
    state.search.composing = true;
  });

  musicInput?.addEventListener("compositionend", (event) => {
    state.search.composing = false;
    if (event.target.value !== state.search.query) {
      state.panelScroll.search = 0;
      state.search.resetScroll = true;
    }
    state.search.query = event.target.value;
    state.search.open = Boolean(event.target.value.trim());
    scheduleSearch();
  });

  musicInput?.addEventListener("focus", () => {
    if (state.search.results.length || state.search.loading) {
      state.search.open = true;
      updateSearchUi();
    }
  });

  musicInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      state.search.open = false;
      updateSearchUi();
    }
  });

  document.querySelector("#music-search")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    // Enter/search-button means "show me the matches", never "guess and play".
    // Playback only begins when the user explicitly chooses a result's Play
    // control. This prevents an unfinished query from hijacking the player.
    try {
      await forceSearchNow();
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error("Search failed:", error);
      }
    }
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      state.search.mode = state.search.mode === mode ? "normal" : mode;
      state.panelScroll.search = 0;
      state.search.resetScroll = true;
      if (searchShouldRun(state.search.query)) {
        scheduleSearch();
      }
      updateSearchUi();
    });
  });

  // Delegated handlers keep working when updateSearchUi() swaps only the
  // dropdown markup. This avoids rebinding/re-rendering the entire Activity
  // every time search results arrive.
  const searchZone = document.querySelector("#search-zone");
  searchZone?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("button");
    if (!button || !button.closest(".search-dropdown")) return;

    try {
      if (button.classList.contains("action-play")) {
        await playTrack(actionTrack(button));
        state.search.open = false;
        updateSearchUi();
        return;
      }

      if (button.classList.contains("action-next")) {
        await addPlayNext(actionTrack(button));
        return;
      }

      if (button.classList.contains("action-like")) {
        await toggleTrackLike(actionTrack(button));
        return;
      }

      if (button.classList.contains("action-add")) {
        const key = String(button.dataset.trackKey || "");
        openAddTarget(key, actionTrack(button));
        return;
      }

      if (button.classList.contains("picker-playlist")) {
        await addTrackToPlaylist(button.dataset.playlist, actionTrack(button));
        return;
      }

      if (button.classList.contains("picker-new")) {
        state.newPlaylistTargetKey = button.dataset.targetKey;
        render();
        setTimeout(() => document.querySelector(".picker-new-name")?.focus(), 0);
      }
    } catch (error) {
      console.error(error);
      setFeedback(error.message || "Action failed", "error");
    }
  });

  searchZone?.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.classList.contains("picker-new-form")) return;

    event.preventDefault();
    const input = form.querySelector(".picker-new-name");
    const name = input?.value.trim() || "";
    if (!name || !state.addTarget?.track) return;

    try {
      await createOwnPlaylist(name, state.addTarget.track);
    } catch (error) {
      setFeedback(error.message || "Could not create playlist.", "error");
    }
  });

  document.querySelector("#member-search")?.addEventListener("input", (event) => {
    state.memberSearch = event.target.value;
    state.panelScroll.members = 0;
    scheduleRender();
  });

  bindAsync("[data-member-select]", "click", async (_event, button) => {
    const userId = button.dataset.memberSelect;
    const wasOpen = state.selectedMemberId === userId;

    // Member folders always reopen cleanly. The user explicitly chooses the
    // profile first, then Liked Songs or Saved Playlists; nothing underneath
    // a member should spring open just because it was open earlier.
    state.expanded.delete(`${userId}:liked`);
    state.expanded.delete(`${userId}:playlists`);
    for (const key of Array.from(state.expandedPlaylists)) {
      if (key.startsWith(`${userId}:`)) state.expandedPlaylists.delete(key);
    }

    state.selectedMemberId = wasOpen ? "" : userId;
    render();
    if (!wasOpen) {
      await loadLibrary(userId, { quiet: true });
      render();
    }
  });

  bindAsync(".section-toggle", "click", async (_event, button) => {
    const key = button.dataset.section;
    const userId = key.split(":")[0];

    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);

    render();
    await loadLibrary(userId, { quiet: true });
    render();
  });

  document.querySelectorAll(".playlist-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const key = `${button.dataset.member}:${button.dataset.playlist}`;
      if (state.expandedPlaylists.has(key)) state.expandedPlaylists.delete(key);
      else state.expandedPlaylists.add(key);
      render();
    });
  });

  bindAsync(".action-play", "click", async (_event, button) => {
    if (button.closest(".search-dropdown")) return;
    const fromSearch = Boolean(button.closest(".search-dropdown"));
    await playTrack(actionTrack(button));
    if (fromSearch) {
      state.search.open = false;
      render();
    }
  });

  bindAsync(".action-next", "click", async (_event, button) => {
    if (button.closest(".search-dropdown")) return;
    await addPlayNext(actionTrack(button));
  });

  bindAsync(".action-like, .queue-like", "click", async (_event, button) => {
    if (button.closest(".search-dropdown")) return;
    await toggleTrackLike(actionTrack(button));
  });

  document.querySelectorAll(".action-add").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.closest(".search-dropdown")) return;
      const key = String(button.dataset.trackKey || "");
      openAddTarget(key, actionTrack(button));
    });
  });

  bindAsync(".liked-delete", "click", async (_event, button) => {
    const track = actionTrack(button);
    if (track && isTrackLiked(track)) await toggleTrackLike(track);
  });

  bindAsync(".playlist-play", "click", async (_event, button) => {
    const playlist = getPlaylist(button.dataset.member, button.dataset.playlist);
    await playPlaylist(playlist, 0);
  });

  bindAsync(".playlist-delete", "click", async (_event, button) => {
    await deleteOwnPlaylist(button.dataset.playlist);
  });

  bindAsync(".playlist-track-play", "click", async (_event, button) => {
    const playlist = getPlaylist(button.dataset.member, button.dataset.playlist);
    await playPlaylist(playlist, Number(button.dataset.trackIndex || 0));
  });

  bindAsync(".playlist-track-remove", "click", async (_event, button) => {
    const key = button.dataset.trackDbKey;
    if (key) await removeOwnPlaylistTrack(button.dataset.playlist, key);
  });

  bindAsync(".queue-play", "click", async (_event, button) => {
    await playerAction("play_queue_item", {
      kind: button.dataset.kind,
      index: Number(button.dataset.index),
    });
  });

  bindAsync(".queue-remove", "click", async (_event, button) => {
    await playerAction("remove_queue", {
      kind: button.dataset.kind,
      index: Number(button.dataset.index),
    });
  });

  bindAsync(".picker-playlist", "click", async (_event, button) => {
    if (button.closest(".search-dropdown")) return;
    await addTrackToPlaylist(button.dataset.playlist, actionTrack(button));
  });

  document.querySelectorAll(".picker-new").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.closest(".search-dropdown")) return;
      state.newPlaylistTargetKey = button.dataset.targetKey;
      render();
      setTimeout(() => document.querySelector(".picker-new-name")?.focus(), 0);
    });
  });

  document.querySelectorAll(".picker-new-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      if (form.closest(".search-dropdown")) return;
      event.preventDefault();
      const input = form.querySelector(".picker-new-name");
      const name = input?.value.trim() || "";
      if (!name || !state.addTarget?.track) return;

      try {
        await createOwnPlaylist(name, state.addTarget.track);
      } catch (error) {
        setFeedback(error.message || "Could not create playlist.", "error");
      }
    });
  });

  const seek = document.querySelector("#timeline-seek");
  seek?.addEventListener("input", () => {
    seek.dataset.dragging = "1";
    const duration = Math.max(1, Number(seek.max || 1));
    const position = Math.max(0, Number(seek.value || 0));
    const pct = Math.min(100, (position / duration) * 100);
    seek.style.setProperty("--seek-progress", `${pct}%`);

    const clocks = document.querySelectorAll(".timeline-line > span");
    if (clocks[0]) clocks[0].textContent = fmtMs(position);
  });

  seek?.addEventListener("change", async () => {
    const positionMs = Math.max(0, Number(seek.value || 0));
    try {
      await playerAction("seek", { positionMs });
    } catch (error) {
      setFeedback(error.message || "Seek failed", "error");
    } finally {
      delete seek.dataset.dragging;
    }
  });

  bindAsync("#pause", "click", async () => playerAction("toggle_pause"));
  bindAsync("#next", "click", async () => playerAction("next"));
  bindAsync("#previous", "click", async () => playerAction("previous"));

  bindAsync("#heart", "click", async (_event, button) => {
    await toggleTrackLike(actionTrack(button));
  });

  document.querySelector("#add")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    openAddTarget("current", actionTrack(button));
  });

  document.querySelector("#theme-add")?.addEventListener("click", () => {
    document.querySelector("#theme-file")?.click();
  });

  document.querySelector("#theme-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await acceptCustomBackground(file);
    } catch (error) {
      setFeedback(error.message || "Could not use that background.", "error");
    } finally {
      event.target.value = "";
    }
  });

  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.addEventListener("click", () => saveThemeChoice(button.dataset.theme));
  });

  document.querySelector("#theme-custom")?.addEventListener("click", () => {
    if (state.theme.custom) saveThemeChoice("custom");
  });

  if (!globalClickBound) {
    globalClickBound = true;
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (
        state.search.open &&
        !target.closest("#search-zone") &&
        !target.closest(".playlist-picker")
      ) {
        state.search.open = false;
        updateSearchUi();
      }
    });
  }
}

// ============================================================
// CLOCK + STARTUP
// ============================================================

setInterval(() => {
  if (state.boot !== "ready" || !currentTrack()) return;

  const position = currentPositionMs();
  const duration = Number(currentTrack()?.durationMs || 0);
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const clocks = document.querySelectorAll(".timeline-line > span");
  if (clocks[0]) clocks[0].textContent = fmtMs(position);

  const seek = document.querySelector("#timeline-seek");
  if (seek && seek.dataset.dragging !== "1") {
    seek.value = String(position);
    seek.style.setProperty("--seek-progress", `${progress}%`);
  }
}, 1000);

async function start() {
  clearSearchTimer();
  cancelSearchRequest();
  clearSocketRetry();
  try {
    state.socket?.close();
  } catch {}

  state.socket = null;
  state.socketConnected = false;
  state.socketRetryAttempt = 0;
  state.sessionToken = "";
  state.boot = "connecting";
  state.bootError = "";
  render();

  try {
    await authenticateActivity();
    render();
  } catch (error) {
    console.error("Activity startup failed:", error);
    state.boot = "error";
    state.bootError = error?.message || "Activity startup failed.";
    render();
  }
}

await start();
