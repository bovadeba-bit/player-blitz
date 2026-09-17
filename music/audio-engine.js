import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";

import {
  preparePlayableTrack,
  trackIdentity,
} from "./resolver.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, "runtime");
const CACHE_DIR = path.join(ROOT_DIR, ".audio-cache");

const YTDLP_PATH =
  process.platform === "win32"
    ? path.join(RUNTIME_DIR, "yt-dlp.exe")
    : path.join(RUNTIME_DIR, "yt-dlp");

const configuredCookie = String(
  process.env.YOUTUBE_COOKIES_FILE || "youtube_cookies.txt"
).trim();
const COOKIE_FILE = path.isAbsolute(configuredCookie)
  ? configuredCookie
  : path.join(ROOT_DIR, configuredCookie);

const DOWNLOAD_TIMEOUT_MS = 75_000;
const DIRECT_RESOLVE_TIMEOUT_MS = 12_000;
const DIRECT_STREAM_CACHE_MS = 12 * 60 * 1000;
const VOICE_READY_TIMEOUT_MS = 20_000;
const PLAYER_READY_TIMEOUT_MS = 15_000;
const MAX_AUDIO_CACHE_FILES = Math.max(
  8,
  Math.min(500, Number(process.env.AUDIO_CACHE_MAX_FILES || 80) || 80)
);
const MAX_AUDIO_CACHE_MB = Math.max(
  64,
  Math.min(8_192, Number(process.env.AUDIO_CACHE_MAX_MB || 512) || 512)
);
const MAX_AUDIO_CACHE_BYTES = MAX_AUDIO_CACHE_MB * 1024 * 1024;
const EARLY_END_TOLERANCE_MS = 15_000;

fs.mkdirSync(CACHE_DIR, { recursive: true });

function commonYtDlpArgs() {
  const args = [
    "--ignore-config",
    "--quiet",
    "--no-warnings",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
  ];

  if (configuredCookie && fs.existsSync(COOKIE_FILE)) {
    args.push("--cookies", COOKIE_FILE);
  }

  return args;
}

function assertRuntime() {
  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error(
      "yt-dlp runtime is missing. Restart with START_ACTIVITY_DEV.bat so ensure_runtime.js can install it."
    );
  }

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error(
      "FFmpeg runtime is missing. Run npm install again in the プレイヤー folder."
    );
  }
}

function cacheStem(track) {
  const identity =
    trackIdentity(track) ||
    `${track?.artist || ""}::${track?.title || ""}`;

  return crypto
    .createHash("sha1")
    .update(String(identity))
    .digest("hex")
    .slice(0, 24);
}

function findCachedFile(stem) {
  try {
    const name = fs
      .readdirSync(CACHE_DIR)
      .find(
        (entry) =>
          entry.startsWith(`${stem}.`) &&
          !entry.endsWith(".part") &&
          !entry.endsWith(".ytdl")
      );

    if (!name) return "";

    const full = path.join(CACHE_DIR, name);
    const stat = fs.statSync(full);

    if (!stat.isFile() || stat.size < 100_000) {
      return "";
    }

    try {
      const now = new Date();
      fs.utimesSync(full, now, now);
    } catch {}

    return full;
  } catch {
    return "";
  }
}

function cleanupAudioCache() {
  try {
    const files = fs
      .readdirSync(CACHE_DIR)
      .map((name) => {
        const full = path.join(CACHE_DIR, name);
        const stat = fs.statSync(full);
        return {
          name,
          full,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          isFile: stat.isFile(),
        };
      })
      .filter((entry) => entry.isFile && entry.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    let keptFiles = 0;
    let keptBytes = 0;

    for (const entry of files) {
      const temporary = entry.name.endsWith(".part") || entry.name.endsWith(".ytdl");
      const keep =
        !temporary &&
        keptFiles < MAX_AUDIO_CACHE_FILES &&
        keptBytes + entry.size <= MAX_AUDIO_CACHE_BYTES;

      if (keep) {
        keptFiles += 1;
        keptBytes += entry.size;
        continue;
      }

      try {
        fs.unlinkSync(entry.full);
      } catch {}
    }
  } catch {}
}

const backgroundDownloadChildren = new Set();
const cancelledBackgroundChildren = new WeakSet();
let backgroundGeneration = 0;

export function cancelBackgroundPrefetches() {
  backgroundGeneration += 1;

  for (const child of [...backgroundDownloadChildren]) {
    cancelledBackgroundChildren.add(child);
    try {
      child.kill("SIGKILL");
    } catch {
      try {
        child.kill();
      } catch {}
    }
  }

  backgroundDownloadChildren.clear();
}

async function waitForBackgroundSlot(generation) {
  while (backgroundDownloadChildren.size >= 1) {
    if (generation !== backgroundGeneration) {
      const error = new Error("Background prefetch was cancelled.");
      error.code = "PREFETCH_CANCELLED";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (generation !== backgroundGeneration) {
    const error = new Error("Background prefetch was cancelled.");
    error.code = "PREFETCH_CANCELLED";
    throw error;
  }
}

function runYtDlpDownload(track, { background = false } = {}) {
  assertRuntime();

  return new Promise((resolve, reject) => {
    const stem = cacheStem(track);
    const target = track.youtubeUrl || track.url;

    if (!target) {
      reject(new Error("Resolved track has no YouTube playback URL."));
      return;
    }

    const outputTemplate = path.join(CACHE_DIR, `${stem}.%(ext)s`);

    const args = [
      ...commonYtDlpArgs(),
      "--no-playlist",
      "--no-progress",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "--socket-timeout",
      "10",
      "--buffer-size",
      "1M",
      "--concurrent-fragments",
      background ? "2" : "8",
      ...(background
        ? ["--limit-rate", "256K"]
        : ["--throttled-rate", "100K"]),
      "--format",
      "bestaudio[acodec=opus][abr<=192]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
      "--output",
      outputTemplate,
      "--print",
      "duration:%(duration)s",
      "--print",
      "after_move:filepath:%(filepath)s",
      target,
    ];

    const child = spawn(YTDLP_PATH, args, {
      cwd: ROOT_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (background) {
      backgroundDownloadChildren.add(child);
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      try {
        child.kill("SIGKILL");
      } catch {}

      reject(
        new Error(
          `Audio preparation timed out after ${Math.round(
            DOWNLOAD_TIMEOUT_MS / 1000
          )} seconds.`
        )
      );
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-9000);
    });

    child.on("error", (error) => {
      backgroundDownloadChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      backgroundDownloadChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        if (background && cancelledBackgroundChildren.has(child)) {
          const error = new Error("Background prefetch was cancelled.");
          error.code = "PREFETCH_CANCELLED";
          reject(error);
          return;
        }

        reject(
          new Error(
            stderr.trim() || `yt-dlp audio download exited with code ${code}`
          )
        );
        return;
      }

      let filepath = "";
      let durationMs = 0;

      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (line.startsWith("duration:")) {
          const seconds = Number(line.slice("duration:".length));
          if (seconds > 0) durationMs = Math.round(seconds * 1000);
        }

        if (line.startsWith("filepath:")) {
          filepath = line.slice("filepath:".length).trim();
        }
      }

      if (!filepath || !fs.existsSync(filepath)) {
        filepath = findCachedFile(stem);
      }

      if (!filepath || !fs.existsSync(filepath)) {
        reject(
          new Error(
            "yt-dlp finished but no local playback file was created."
          )
        );
        return;
      }

      cleanupAudioCache();

      resolve({
        filepath,
        durationMs,
      });
    });
  });
}

const directStreamCache = new Map();

function pruneDirectStreamCache(maxEntries = 120) {
  const now = Date.now();
  for (const [key, value] of directStreamCache) {
    if (!value?.url || Number(value.expiresAt || 0) <= now) {
      directStreamCache.delete(key);
    }
  }

  while (directStreamCache.size > maxEntries) {
    const oldest = directStreamCache.keys().next().value;
    if (!oldest) break;
    directStreamCache.delete(oldest);
  }
}

function directExpiryFromUrl(url) {
  try {
    const parsed = new URL(url);
    const expire = Number(parsed.searchParams.get("expire") || 0);
    if (expire > 0) {
      return Math.max(Date.now() + 30_000, expire * 1000 - 60_000);
    }
  } catch {}

  return Date.now() + DIRECT_STREAM_CACHE_MS;
}

function runYtDlpDirectResolve(track) {
  assertRuntime();

  return new Promise((resolve, reject) => {
    const target = track.youtubeUrl || track.url;

    if (!target) {
      reject(new Error("Resolved track has no YouTube playback URL."));
      return;
    }

    const args = [
      ...commonYtDlpArgs(),
      "--no-playlist",
      "--format",
      "bestaudio[acodec=opus][abr<=192]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
      "--dump-single-json",
      "--skip-download",
      target,
    ];

    const child = spawn(YTDLP_PATH, args, {
      cwd: ROOT_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcess(child);
      reject(
        new Error(
          `Fast stream resolution timed out after ${Math.round(
            DIRECT_RESOLVE_TIMEOUT_MS / 1000
          )} seconds.`
        )
      );
    }, DIRECT_RESOLVE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-7000);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `yt-dlp stream resolver exited with code ${code}`
          )
        );
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const candidates = [
          info,
          ...(Array.isArray(info?.requested_downloads)
            ? info.requested_downloads
            : []),
          ...(Array.isArray(info?.requested_formats)
            ? info.requested_formats
            : []),
        ].filter(Boolean);

        let selected = candidates.find(
          (item) =>
            item?.url &&
            item?.acodec &&
            item.acodec !== "none" &&
            (!item?.vcodec || item.vcodec === "none")
        );

        if (!selected) {
          selected = candidates.find((item) => item?.url) || null;
        }

        if (!selected?.url) {
          throw new Error("yt-dlp returned no direct audio URL.");
        }

        const headers = {
          ...(info?.http_headers || {}),
          ...(selected?.http_headers || {}),
        };

        const durationMs =
          Math.round(
            Number(selected?.duration || info?.duration || 0) * 1000
          ) || Number(track.durationMs || 0);

        resolve({
          track: {
            ...track,
            durationMs,
          },
          url: String(selected.url),
          headers,
          expiresAt: directExpiryFromUrl(String(selected.url)),
          sourceType: "remote",
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function resolveDirectAudioSource(rawTrack, { force = false } = {}) {
  const prepared = await preparePlayableTrack(rawTrack);
  const key = trackIdentity(prepared);

  if (!force) {
    pruneDirectStreamCache();
    const cached = directStreamCache.get(key);
    if (cached?.url && cached.expiresAt > Date.now() + 30_000) {
      return cached;
    }
  }

  const direct = await runYtDlpDirectResolve(prepared);
  directStreamCache.set(key, direct);
  pruneDirectStreamCache();
  return direct;
}

const audioCache = new Map();
const audioDownloads = new Map();
const audioPrefetch = new Map();


async function getReadyCachedAudio(rawTrack) {
  const prepared = await preparePlayableTrack(rawTrack);
  const key = trackIdentity(prepared);
  const stem = cacheStem(prepared);

  const memory = audioCache.get(key);
  if (memory?.filepath && fs.existsSync(memory.filepath)) {
    return {
      ...memory,
      sourceType: "local",
    };
  }

  const disk = findCachedFile(stem);
  if (!disk) return null;

  const cached = {
    track: prepared,
    filepath: disk,
    durationMs: Number(prepared.durationMs || 0),
    sourceType: "local",
  };

  audioCache.set(key, cached);
  return cached;
}

export async function ensureCachedAudio(
  rawTrack,
  { force = false, background = false } = {}
) {
  const prepared = await preparePlayableTrack(rawTrack);
  const key = trackIdentity(prepared);
  const stem = cacheStem(prepared);

  if (!force) {
    const memory = audioCache.get(key);
    if (memory?.filepath && fs.existsSync(memory.filepath)) {
      try {
        const now = new Date();
        fs.utimesSync(memory.filepath, now, now);
      } catch {}
      return memory;
    }

    const disk = findCachedFile(stem);
    if (disk) {
      const cached = {
        track: prepared,
        filepath: disk,
        durationMs: Number(prepared.durationMs || 0),
      };
      audioCache.set(key, cached);
      return cached;
    }
  }

  if (!force && audioDownloads.has(key)) {
    return audioDownloads.get(key);
  }

  const generation = backgroundGeneration;

  const task = (async () => {
    if (background) {
      await waitForBackgroundSlot(generation);
    }

    const downloaded = await runYtDlpDownload(prepared, { background });
    const durationMs =
      Number(downloaded.durationMs || 0) ||
      Number(prepared.durationMs || 0);

    const result = {
      track: {
        ...prepared,
        durationMs,
      },
      filepath: downloaded.filepath,
      durationMs,
    };

    audioCache.set(trackIdentity(result.track), result);
    return result;
  })().finally(() => {
    if (audioDownloads.get(key) === task) {
      audioDownloads.delete(key);
    }
  });

  audioDownloads.set(key, task);
  return task;
}

export function prefetchAudio(rawTrack) {
  const identity = trackIdentity(rawTrack);
  if (!identity) return Promise.resolve(null);

  const ready = audioCache.get(identity);
  if (ready?.filepath && fs.existsSync(ready.filepath)) {
    return Promise.resolve(ready);
  }

  if (audioPrefetch.has(identity)) {
    return audioPrefetch.get(identity);
  }

  const task = ensureCachedAudio(rawTrack, { background: true })
    .catch((error) => {
      if (error?.code !== "PREFETCH_CANCELLED") {
        console.warn(
          `[prefetch] ${rawTrack?.title || "track"}: ${error.message}`
        );
      }
      return null;
    })
    .finally(() => {
      audioPrefetch.delete(identity);
    });

  audioPrefetch.set(identity, task);
  return task;
}

function killProcess(child) {
  if (!child) return;
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

function headerString(headers) {
  if (!headers || typeof headers !== "object") return "";

  return Object.entries(headers)
    .filter(
      ([key, value]) =>
        key && value != null && !/^content-length$/i.test(key)
    )
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\r\n");
}

function spawnTrackFfmpeg(source, seekMs = 0, bitrateKbps = 96) {
  assertRuntime();

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
  ];

  if (source?.url) {
    const headers = headerString(source.headers);

    args.push(
      "-rw_timeout",
      "15000000",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "2"
    );

    if (headers) {
      args.push("-headers", `${headers}\r\n`);
    }
  }

  if (seekMs > 0) {
    args.push("-ss", (seekMs / 1000).toFixed(3));
  }

  args.push(
    "-i",
    source.filepath || source.url,
    "-vn",
    "-sn",
    "-dn",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "libopus",
    "-b:a",
    `${Math.max(48, Math.min(128, Number(bitrateKbps || 96)))}k`,
    "-vbr",
    "constrained",
    "-compression_level",
    "5",
    "-frame_duration",
    "20",
    "-application",
    "audio",
    "-page_duration",
    "20000",
    "-flush_packets",
    "1",
    "-f",
    "ogg",
    "pipe:1"
  );

  const child = spawn(ffmpegPath, args, {
    cwd: ROOT_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrTail = "";

  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-7000);
  });

  child.on("close", (code) => {
    if (code !== 0 && code !== null && stderrTail.trim()) {
      console.warn(`[ffmpeg] exited ${code}: ${stderrTail.trim()}`);
    }
  });

  return child;
}

function statusError(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sessionStatus(session) {
  if (!session) {
    return {
      connected: false,
      channelId: "",
      channelName: "",
      status: "idle",
    };
  }

  return {
    connected:
      Boolean(session.connection) &&
      session.connection.state.status !== VoiceConnectionStatus.Destroyed,
    channelId: session.channelId || "",
    channelName: session.channelName || "",
    bitrateKbps: Number(session.bitrateKbps || 0),
    sourceType: session.sourceType || "",
    status: session.status || "idle",
  };
}

export class DiscordAudioEngine {
  constructor({
    client,
    onNaturalEnd,
    onPrematureEnd,
    onError,
    onStatus,
  }) {
    this.client = client;
    this.onNaturalEnd = onNaturalEnd;
    this.onPrematureEnd = onPrematureEnd;
    this.onError = onError;
    this.onStatus = onStatus;
    this.sessions = new Map();
  }

  getStatus(guildId) {
    return sessionStatus(this.sessions.get(String(guildId)));
  }

  hasConnection(guildId) {
    return this.getStatus(guildId).connected;
  }

  async #resolveVoiceTarget(guildId, userId) {
    const id = String(guildId);
    const existing = this.sessions.get(id);

    if (
      existing?.connection &&
      existing.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      existing.channelId
    ) {
      const guild =
        this.client.guilds.cache.get(id) ||
        (await this.client.guilds.fetch(id));
      const channel =
        guild.channels.cache.get(existing.channelId) ||
        (await guild.channels.fetch(existing.channelId).catch(() => null));

      if (channel?.isVoiceBased?.()) {
        return { guild, channel };
      }
    }

    if (!userId) {
      throw statusError(
        "プレイヤー is not connected to voice. Join a voice channel and start a song first."
      );
    }

    const guild =
      this.client.guilds.cache.get(id) ||
      (await this.client.guilds.fetch(id));
    const member = await guild.members.fetch(String(userId));
    const channel = member.voice?.channel || null;

    if (!channel?.isVoiceBased?.()) {
      throw statusError(
        "Join a voice channel first, then press Play again."
      );
    }

    return { guild, channel };
  }

  async ensureVoice(guildId, userId = "") {
    const id = String(guildId);
    const { guild, channel } = await this.#resolveVoiceTarget(id, userId);
    let session = this.sessions.get(id);

    if (
      session?.connection &&
      session.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      session.channelId === channel.id
    ) {
      session.bitrateKbps = Math.max(
        48,
        Math.min(
          128,
          Math.floor(Number(channel.bitrate || 96_000) / 1000)
        )
      );

      await entersState(
        session.connection,
        VoiceConnectionStatus.Ready,
        VOICE_READY_TIMEOUT_MS
      );
      return session;
    }

    if (session) {
      this.destroy(id);
    }

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    session = {
      guildId: id,
      channelId: channel.id,
      channelName: channel.name || "Voice",
      bitrateKbps: Math.max(
        48,
        Math.min(128, Math.floor(Number(channel.bitrate || 96_000) / 1000))
      ),
      connection,
      player,
      subscription: null,
      token: 0,
      requestToken: 0,
      ffmpeg: null,
      currentTrack: null,
      seekMs: 0,
      resource: null,
      status: "connecting",
      earlyRetryCount: 0,
      sourceType: "",
    };

    this.sessions.set(id, session);

    player.on("error", (error) => {
      this.onError?.({
        guildId: id,
        error,
        track: session.currentTrack,
      });
    });

    player.on(AudioPlayerStatus.Idle, (oldState) => {
      const metadata = oldState?.resource?.metadata;
      if (!metadata || Number(metadata.token) !== Number(session.token)) {
        return;
      }

      const playbackDuration = Number(
        oldState?.resource?.playbackDuration || 0
      );
      const reachedMs = Math.max(
        0,
        Number(session.seekMs || 0) + playbackDuration
      );
      const durationMs = Number(session.currentTrack?.durationMs || 0);
      const endedEarly =
        durationMs > 0 &&
        reachedMs + EARLY_END_TOLERANCE_MS < durationMs;

      session.status = "idle";
      session.resource = null;
      session.ffmpeg = null;
      this.#emitStatus(id);

      if (endedEarly && session.earlyRetryCount < 1) {
        session.earlyRetryCount += 1;
        this.onPrematureEnd?.({
          guildId: id,
          track: session.currentTrack,
          positionMs: Math.max(0, reachedMs - 1500),
        });
        return;
      }

      session.earlyRetryCount = 0;
      this.onNaturalEnd?.({
        guildId: id,
        track: session.currentTrack,
        positionMs: reachedMs,
      });
    });

    connection.on("error", (error) => {
      this.onError?.({
        guildId: id,
        error,
        track: session.currentTrack,
      });
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (this.sessions.get(id) === session) {
          this.destroy(id);
          this.#emitStatus(id);
        }
      }
    });

    try {
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        VOICE_READY_TIMEOUT_MS
      );
    } catch (error) {
      this.destroy(id);
      throw statusError(
        `Could not join ${channel.name}. Check the bot's Connect/Speak permissions.`,
        409
      );
    }

    session.subscription = connection.subscribe(player);
    session.status = "idle";
    this.#emitStatus(id);
    return session;
  }

  async play(
    guildId,
    userId,
    rawTrack,
    { seekMs = 0, preserveEarlyRetry = false } = {}
  ) {
    const id = String(guildId);
    const session = await this.ensureVoice(id, userId);

    session.requestToken = Number(session.requestToken || 0) + 1;
    const requestToken = session.requestToken;
    const requestedSeekMs = Math.max(0, Number(seekMs || 0));
    const startedAt = Date.now();

    session.status = "preparing";
    this.#emitStatus(id);

    let source = null;

    try {
      // Fastest path: an already cached/prefetched song needs no provider
      // lookup before playback.
      source = await getReadyCachedAudio(rawTrack);

      if (!source) {
        // Cold-cache path: resolve only a signed media URL. We intentionally
        // do NOT wait for a complete track download before playback begins.
        source = await resolveDirectAudioSource(rawTrack, {
          force: Boolean(preserveEarlyRetry),
        });
      }
    } catch (fastError) {
      // Provider edge-case fallback: the old complete-local-file path remains
      // available so a failed fast path does not become silence.
      try {
        source = await ensureCachedAudio(rawTrack);
        source.sourceType = "local";
      } catch (error) {
        if (
          this.sessions.get(id) === session &&
          session.requestToken === requestToken
        ) {
          session.status = session.resource ? "playing" : "idle";
          this.#emitStatus(id);
        }

        if (!error.code) error.code = "AUDIO_PREPARE_FAILED";
        error.message =
          `${error.message} (fast-start also failed: ${fastError.message})`;
        throw error;
      }
    }

    if (
      this.sessions.get(id) !== session ||
      session.requestToken !== requestToken
    ) {
      const error = new Error("Playback request was superseded.");
      error.code = "PLAYBACK_SUPERSEDED";
      throw error;
    }

    session.token += 1;
    const token = session.token;

    killProcess(session.ffmpeg);
    session.ffmpeg = null;
    session.resource = null;
    session.currentTrack = source.track;
    session.seekMs = requestedSeekMs;
    session.sourceType = source.filepath ? "local" : "remote";

    if (!preserveEarlyRetry) {
      session.earlyRetryCount = 0;
    }

    try {
      session.player.stop(true);
    } catch {}

    const ffmpeg = spawnTrackFfmpeg(
      source,
      session.seekMs,
      session.bitrateKbps
    );

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
      metadata: {
        guildId: id,
        token,
        trackKey: trackIdentity(source.track),
      },
    });

    session.ffmpeg = ffmpeg;
    session.resource = resource;
    session.currentTrack = source.track;
    session.status = "starting";
    this.#emitStatus(id);

    session.player.play(resource);

    try {
      await entersState(
        session.player,
        AudioPlayerStatus.Playing,
        PLAYER_READY_TIMEOUT_MS
      );
    } catch (error) {
      if (session.token === token) {
        session.token += 1;
        killProcess(session.ffmpeg);
        session.ffmpeg = null;
        session.resource = null;
        session.status = "idle";
        try {
          session.player.stop(true);
        } catch {}
        this.#emitStatus(id);
      }

      throw statusError(
        "Discord voice did not begin playing the resolved track.",
        502
      );
    }

    if (session.token !== token) {
      const error = new Error("Playback request was superseded.");
      error.code = "PLAYBACK_SUPERSEDED";
      throw error;
    }

    session.status = "playing";
    this.#emitStatus(id);

    console.log(
      `[audio-start] "${source.track.title}" ` +
      `source=${session.sourceType} ` +
      `startup=${Date.now() - startedAt}ms`
    );

    // Hybrid safety net: remote starts immediately, then the old stable local
    // cache is built behind playback. Premature-end retry will prefer this
    // completed local file if it is ready.
    if (session.sourceType === "remote") {
      setTimeout(() => {
        if (
          this.sessions.get(id) === session &&
          session.token === token &&
          session.currentTrack &&
          trackIdentity(session.currentTrack) === trackIdentity(source.track)
        ) {
          prefetchAudio(source.track).catch(() => {});
        }
      }, 1_500);
    }

    return {
      track: source.track,
      channelId: session.channelId,
      channelName: session.channelName,
      seekMs: session.seekMs,
      sourceType: session.sourceType,
    };
  }

  pause(guildId) {
    const session = this.sessions.get(String(guildId));
    if (!session?.currentTrack) return false;

    const changed = session.player.pause(true);
    if (changed) {
      session.status = "paused";
      this.#emitStatus(String(guildId));
    }
    return changed;
  }

  resume(guildId) {
    const session = this.sessions.get(String(guildId));
    if (!session?.currentTrack) return false;

    const changed = session.player.unpause();
    if (changed) {
      session.status = "playing";
      this.#emitStatus(String(guildId));
    }
    return changed;
  }

  stop(guildId) {
    const id = String(guildId);
    const session = this.sessions.get(id);
    if (!session) return;

    session.requestToken = Number(session.requestToken || 0) + 1;
    session.token += 1;
    killProcess(session.ffmpeg);
    session.ffmpeg = null;
    session.resource = null;
    session.currentTrack = null;
    session.seekMs = 0;
    session.sourceType = "";
    session.status = "idle";
    session.earlyRetryCount = 0;

    try {
      session.player.stop(true);
    } catch {}

    this.#emitStatus(id);
  }

  destroy(guildId) {
    const id = String(guildId);
    const session = this.sessions.get(id);
    if (!session) return;

    session.requestToken = Number(session.requestToken || 0) + 1;
    session.token += 1;
    killProcess(session.ffmpeg);

    try {
      session.player.stop(true);
    } catch {}

    try {
      session.subscription?.unsubscribe();
    } catch {}

    try {
      session.connection.destroy();
    } catch {}

    this.sessions.delete(id);
  }

  prefetch(rawTrack) {
    return prefetchAudio(rawTrack);
  }

  cancelPrefetches() {
    cancelBackgroundPrefetches();
  }

  #emitStatus(guildId) {
    this.onStatus?.({
      guildId: String(guildId),
      status: this.getStatus(guildId),
    });
  }
}

export function audioRuntimeStatus() {
  return {
    ytDlpReady: fs.existsSync(YTDLP_PATH),
    ffmpegReady: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    cacheDir: CACHE_DIR,
    cacheLimitFiles: MAX_AUDIO_CACHE_FILES,
    cacheLimitMb: MAX_AUDIO_CACHE_MB,
    playbackMode: "hybrid-fast-start",
  };
}
