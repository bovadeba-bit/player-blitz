import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import spotifyUrlInfoFactory from "spotify-url-info";
import { Innertube, UniversalCache } from "youtubei.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, "runtime");
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

const spotify = spotifyUrlInfoFactory(globalThis.fetch);
const YOUTUBEJS_CACHE_DIR = path.join(ROOT_DIR, ".ytjs-cache");

const SEARCH_RESULTS = 8;
const FAST_SEARCH_TIMEOUT_MS = 3_800;
const SEARCH_TIMEOUT_MS = 11_000;
const PLAYLIST_TIMEOUT_MS = 25_000;
const SPOTIFY_TIMEOUT_MS = 15_000;
const RADIO_CANDIDATES = 18;

const BAD_VERSION_TERMS = [
  "live",
  "concert",
  "remix",
  "edit",
  "sped up",
  "speed up",
  "slowed",
  "reverb",
  "nightcore",
  "8d",
  "karaoke",
  "cover",
  "instrumental",
  "bass boosted",
  "extended",
  "mashup",
  "phonk",
];

const VIDEO_TERMS = [
  "official music video",
  "music video",
  "video oficial",
  "official video",
  "trailer",
  "teaser",
  "behind the scenes",
  "reaction",
];

const RADIO_REJECT_TERMS = [
  ...BAD_VERSION_TERMS.filter((term) => term !== "phonk"),
  "lyrics",
  "lyric video",
  "fan made",
  "fanmade",
];

const spotifyPreviewCache = new Map();
const prepareCache = new Map();
const searchCache = new Map();
let innertubePromise = null;

function pruneTimedCache(cache, maxEntries) {
  const now = Date.now();

  for (const [key, value] of cache) {
    if (Number(value?.expiresAt || 0) <= now) cache.delete(key);
  }

  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wordSet(value) {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((word) => word.length > 1)
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isSpotifyUrl(value) {
  const host = hostname(value);
  return host === "open.spotify.com" || host.endsWith(".spotify.com");
}

export function isYouTubeUrl(value) {
  const host = hostname(value);
  return (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "music.youtube.com"
  );
}

function spotifyKind(value) {
  try {
    return new URL(value).pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

function cleanSpotifyUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }
    return url.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function spotifyUriToUrl(uri) {
  const value = String(uri || "");
  const match = /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i.exec(value);
  if (!match) return "";
  return `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`;
}

function cleanTrack(raw) {
  return {
    title: String(raw?.title || "Unknown title"),
    artist: String(raw?.artist || "Unknown artist"),
    url: String(raw?.url || ""),
    youtubeUrl: String(raw?.youtubeUrl || ""),
    cover: String(raw?.cover || ""),
    durationMs: Math.max(0, Number(raw?.durationMs || 0) || 0),
    source: String(raw?.source || "unknown"),
    mode: String(raw?.mode || "normal"),
    originalQuery: raw?.originalQuery ? String(raw.originalQuery) : "",
  };
}

function artworkCandidateScore(candidate) {
  if (!candidate) return -1;

  const url = String(candidate?.url || candidate || "");
  if (!url) return -1;

  const width = Math.max(0, Number(candidate?.width || 0) || 0);
  const height = Math.max(0, Number(candidate?.height || 0) || 0);
  let score = width * height;

  const tinyMatch = /(?:^|[^a-z])w(\d+)-h(\d+)/i.exec(url);
  if (tinyMatch) {
    score = Math.max(score, Number(tinyMatch[1]) * Number(tinyMatch[2]));
  }

  if (/w(?:40|48|50|60|64|72|80)-h(?:40|48|50|60|64|72|80)/i.test(url)) {
    score -= 2_000_000;
  }

  if (/maxresdefault|sddefault|hqdefault/i.test(url)) score += 500_000;
  return score;
}

function upgradeArtworkUrl(raw, videoId = "") {
  let url = String(raw || "");
  if (!url) {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
  }

  // YouTube Music frequently hands us a perfectly good artwork URL with a
  // tiny w60-h60 transform. Ask the same CDN for a larger rendition instead
  // of stretching 60px artwork across the center stage.
  if (/googleusercontent\.com/i.test(url)) {
    url = url.replace(/w\d+-h\d+/i, "w544-h544");
  }

  // Flat yt-dlp results sometimes expose the low-resolution `default.jpg`.
  // hqdefault is widely available and is a much safer visual fallback.
  if (/i\.ytimg\.com\/vi\//i.test(url)) {
    url = url.replace(/\/(?:default|mqdefault)\.jpg(?:\?.*)?$/i, "/hqdefault.jpg");
  }

  return url;
}

function bestArtworkUrl(candidates, videoId = "") {
  const flat = (candidates || [])
    .flat(Infinity)
    .filter(Boolean)
    .map((candidate) =>
      typeof candidate === "string" ? { url: candidate } : candidate
    )
    .filter((candidate) => String(candidate?.url || ""));

  flat.sort((a, b) => artworkCandidateScore(b) - artworkCandidateScore(a));
  return upgradeArtworkUrl(flat[0]?.url || "", videoId);
}

export function trackIdentity(raw) {
  const item = cleanTrack(raw);
  if (item.youtubeUrl) {
    return item.youtubeUrl.split("&list=")[0].toLowerCase();
  }
  if (item.url) {
    return item.url.split("?si=")[0].toLowerCase();
  }
  return `${normalizeText(item.artist)}::${normalizeText(item.title)}`;
}

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

function assertYtDlp() {
  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error(
      "yt-dlp runtime is missing. Restart with START_ACTIVITY_DEV.bat so ensure_runtime.js can install it."
    );
  }
}

function runYtDlpJson(target, extraArgs = [], timeoutMs = SEARCH_TIMEOUT_MS) {
  assertYtDlp();

  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP_PATH,
      [
        ...commonYtDlpArgs(),
        ...extraArgs,
        "--dump-single-json",
        "--skip-download",
        target,
      ],
      {
        cwd: ROOT_DIR,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`yt-dlp metadata lookup timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 20 * 1024 * 1024) {
        try { child.kill("SIGKILL"); } catch {}
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`yt-dlp returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function youtubeEntryToTrack(entry, extra = {}) {
  const id = entry?.id || youtubeVideoId(entry?.webpage_url || entry?.url || "");

  let url = entry?.webpage_url || entry?.original_url || "";
  if (!isHttpUrl(url) && id) {
    url = `https://www.youtube.com/watch?v=${id}`;
  }
  if (!url && isHttpUrl(entry?.url)) {
    url = entry.url;
  }

  return cleanTrack({
    title: entry?.title || entry?.fulltitle || "Unknown title",
    artist: entry?.artist || entry?.uploader || entry?.channel || "Unknown artist",
    url,
    youtubeUrl: url,
    cover: bestArtworkUrl(
      [entry?.thumbnails, entry?.thumbnail ? [{ url: entry.thumbnail }] : []],
      id
    ),
    durationMs: Math.round(Number(entry?.duration || 0) * 1000),
    source: "youtube",
    mode: extra.mode || "normal",
    originalQuery: extra.originalQuery || "",
  });
}

function spotifyArtist(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((artist) => (typeof artist === "string" ? artist : artist?.name))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") return value.name || "";
  return "";
}

function spotifyDurationMs(track, raw) {
  const candidates = [
    track?.duration_ms,
    track?.durationMs,
    track?.duration?.totalMilliseconds,
    raw?.duration_ms,
    raw?.durationMs,
    raw?.duration?.totalMilliseconds,
  ];

  for (const value of candidates) {
    const number = Number(value || 0);
    if (number > 1000) return Math.round(number);
  }

  for (const value of [track?.duration, raw?.duration]) {
    const number = Number(value || 0);
    if (!number) continue;
    if (number > 1000) return Math.round(number);
    if (number > 0 && number < 36000) return Math.round(number * 1000);
  }

  return 0;
}

function spotifyTrackToItem(raw, parentUrl, fallbackCover = "", mode = "normal") {
  const track = raw && typeof raw.track === "object" ? raw.track : raw;

  const title =
    track?.name ||
    track?.title ||
    (typeof raw?.track === "string" ? raw.track : "") ||
    "Unknown title";

  const artist =
    spotifyArtist(track?.artists) ||
    spotifyArtist(track?.artist) ||
    spotifyArtist(raw?.artists) ||
    spotifyArtist(raw?.artist) ||
    "Unknown artist";

  const images = track?.album?.images || raw?.album?.images || raw?.images || [];
  const spotifyId = track?.id || raw?.id || "";
  const uriUrl = spotifyUriToUrl(track?.uri || raw?.uri);

  const specificUrl =
    track?.external_urls?.spotify ||
    raw?.external_urls?.spotify ||
    track?.link ||
    raw?.link ||
    uriUrl ||
    (spotifyId ? `https://open.spotify.com/track/${spotifyId}` : "");

  return cleanTrack({
    title,
    artist,
    url: specificUrl,
    youtubeUrl: "",
    cover: track?.image || raw?.image || images?.[0]?.url || fallbackCover || "",
    durationMs: spotifyDurationMs(track, raw),
    source: "spotify",
    mode,
    originalQuery: parentUrl,
  });
}

function searchSuffix(mode) {
  if (mode === "slow") return "slowed + reverb";
  if (mode === "fast") return "sped up";
  return "";
}

function stripSearchDecorators(value) {
  let text = String(value || "");
  const terms = [
    ...BAD_VERSION_TERMS,
    ...VIDEO_TERMS,
    "official audio",
    "official",
    "audio",
    "lyrics",
    "lyric video",
    "visualizer",
    "hd",
    "4k",
  ];

  for (const term of terms) {
    text = text.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "ig"), " ");
  }

  return text.replace(/[()[\]{}|_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanChannelForSearch(value) {
  return String(value || "")
    .replace(/\bvevo\b/ig, " ")
    .replace(/\b(topic|official|music|records|recordings|channel)\b/ig, " ")
    .replace(/[-_|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requestedVersionAllows(term, query, mode) {
  const q = normalizeText(query);
  if (q.includes(normalizeText(term))) return true;
  if (mode === "slow" && (term.includes("slowed") || term.includes("reverb"))) return true;
  if (mode === "fast" && (term.includes("sped up") || term.includes("speed up"))) return true;
  return false;
}

function candidateHasVideoTerm(candidate) {
  const all = normalizeText(`${candidate.title} ${candidate.artist}`);
  return VIDEO_TERMS.some((term) => all.includes(term));
}

function candidateHasUnwantedVersion(candidate, query, mode) {
  const all = normalizeText(`${candidate.title} ${candidate.artist}`);
  return BAD_VERSION_TERMS.some(
    (term) => all.includes(term) && !requestedVersionAllows(term, query, mode)
  );
}

function scoreCandidate(candidate, query, mode, target = null) {
  const title = normalizeText(candidate.title);
  const artist = normalizeText(candidate.artist);
  const all = `${title} ${artist}`;
  const queryWords = wordSet(query);
  const titleWords = wordSet(candidate.title);
  const artistWords = wordSet(candidate.artist);

  let score = 0;

  for (const word of queryWords) {
    if (titleWords.has(word)) score += 12;
    if (artistWords.has(word)) score += 16;
  }

  if (title.includes("official audio")) score += 45;
  if (title.includes("audio")) score += 12;
  if (artist.includes("topic")) score += 28;
  if (title.includes("visualizer")) score += 6;

  for (const term of VIDEO_TERMS) {
    if (all.includes(term)) score -= 100;
  }

  for (const term of BAD_VERSION_TERMS) {
    if (all.includes(term) && !requestedVersionAllows(term, query, mode)) {
      score -= term === "phonk" ? 160 : 58;
    }
  }

  if (mode === "slow") {
    if (all.includes("slowed")) score += 55;
    if (all.includes("reverb")) score += 35;
  }

  if (mode === "fast" && (all.includes("sped up") || all.includes("speed up"))) {
    score += 60;
  }

  if (candidate.durationMs > 20 * 60 * 1000) score -= 70;

  if (target) {
    const targetTitle = wordSet(target.title);
    const targetArtist = wordSet(target.artist);

    for (const word of targetTitle) {
      if (titleWords.has(word)) score += 25;
    }

    for (const word of targetArtist) {
      if (titleWords.has(word) || artistWords.has(word)) score += 32;
    }

    if (target.durationMs > 0 && candidate.durationMs > 0) {
      const diff = Math.abs(target.durationMs - candidate.durationMs);
      if (diff <= 7_000) score += 38;
      else if (diff <= 20_000) score += 16;
      else if (diff >= 60_000) score -= 35;
    }
  }

  return score;
}

function safeSpotifyMatch(candidate, target, mode = "normal") {
  const targetTitle = wordSet(target.title);
  const targetArtist = wordSet(target.artist);
  const candidateTitle = wordSet(candidate.title);
  const candidateAll = wordSet(`${candidate.title} ${candidate.artist}`);

  if (!targetTitle.size) return false;

  let titleHits = 0;
  for (const word of targetTitle) {
    if (candidateTitle.has(word)) titleHits += 1;
  }

  const required = targetTitle.size <= 2 ? 1 : Math.ceil(targetTitle.size * 0.6);
  if (titleHits < required) return false;

  if (targetArtist.size) {
    let artistHit = false;
    for (const word of targetArtist) {
      if (candidateAll.has(word)) {
        artistHit = true;
        break;
      }
    }
    if (!artistHit) return false;
  }

  const targetText = normalizeText(`${target.title} ${target.artist}`);
  const candidateText = normalizeText(`${candidate.title} ${candidate.artist}`);

  for (const term of BAD_VERSION_TERMS) {
    if (
      candidateText.includes(term) &&
      !targetText.includes(term) &&
      !requestedVersionAllows(term, `${target.title} ${target.artist}`, mode)
    ) {
      return false;
    }
  }
  for (const term of VIDEO_TERMS) {
    if (candidateText.includes(term)) return false;
  }

  return true;
}


async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      cache: new UniversalCache(true, YOUTUBEJS_CACHE_DIR),
      generate_session_locally: true,
      lang: "en",
      fast_fail: false,
    }).catch((error) => {
      innertubePromise = null;
      throw error;
    });
  }

  return withTimeout(
    innertubePromise,
    FAST_SEARCH_TIMEOUT_MS,
    "YouTube Music session"
  );
}

function ytjsText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;

  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.name === "string") return value.name;

    if (Array.isArray(value.runs)) {
      return value.runs
        .map((run) => String(run?.text || ""))
        .filter(Boolean)
        .join("");
    }
  }

  try {
    const rendered = String(value);
    return rendered === "[object Object]" ? "" : rendered;
  } catch {
    return "";
  }
}

function ytjsThumbnail(node) {
  const candidates = [
    node?.best_thumbnail,
    ...(Array.isArray(node?.thumbnails) ? node.thumbnails : []),
    ...(Array.isArray(node?.thumbnail?.contents)
      ? node.thumbnail.contents
      : []),
    ...(Array.isArray(node?.thumbnail) ? node.thumbnail : []),
  ].filter(Boolean);

  return bestArtworkUrl(candidates, String(node?.id || node?.video_id || ""));
}

function ytjsArtist(node) {
  const people = [
    ...(Array.isArray(node?.artists) ? node.artists : []),
    ...(Array.isArray(node?.authors) ? node.authors : []),
  ];

  const joined = people
    .map((person) => String(person?.name || ytjsText(person)))
    .filter(Boolean)
    .join(", ");

  return (
    joined ||
    String(node?.author?.name || "") ||
    ytjsText(node?.subtitle) ||
    "Unknown artist"
  );
}

function ytjsNodeToTrack(node, extra = {}) {
  const id = String(node?.id || node?.video_id || "");
  if (!id) return null;

  const title =
    typeof node?.title === "string"
      ? node.title
      : ytjsText(node?.title);

  if (!title) return null;

  const seconds =
    Number(node?.duration?.seconds || 0) ||
    0;

  const url = `https://www.youtube.com/watch?v=${id}`;

  return cleanTrack({
    title,
    artist: ytjsArtist(node),
    url,
    youtubeUrl: url,
    cover: ytjsThumbnail(node),
    durationMs: seconds > 0 ? Math.round(seconds * 1000) : 0,
    source: "youtube",
    mode: extra.mode || "normal",
    originalQuery: extra.originalQuery || "",
  });
}

export async function warmSearchEngine() {
  try {
    await getInnertube();
    return true;
  } catch (error) {
    innertubePromise = null;
    console.warn(`[search warmup] ${error.message}`);
    return false;
  }
}

async function searchViaInnertube(query, mode, count) {
  const yt = await getInnertube();

  if (mode === "normal") {
    const result = await withTimeout(
      yt.music.search(query, { type: "song" }),
      FAST_SEARCH_TIMEOUT_MS,
      "YouTube Music search"
    );

    const nodes = Array.from(result?.songs?.contents || []);
    return nodes
      .slice(0, count)
      .map((node) =>
        ytjsNodeToTrack(node, {
          mode,
          originalQuery: query,
        })
      )
      .filter(Boolean);
  }

  const effective = `${query} ${searchSuffix(mode)}`.trim();

  const result = await withTimeout(
    yt.search(effective, { type: "video" }),
    FAST_SEARCH_TIMEOUT_MS,
    "YouTube search"
  );

  const nodes = Array.from(
    result?.videos ||
    result?.results ||
    []
  );

  return nodes
    .slice(0, count)
    .map((node) =>
      ytjsNodeToTrack(node, {
        mode,
        originalQuery: query,
      })
    )
    .filter(Boolean);
}

function mergeUniqueTracks(...groups) {
  const seen = new Set();
  const merged = [];

  for (const group of groups) {
    for (const item of group || []) {
      const identity = trackIdentity(item);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      merged.push(item);
    }
  }

  return merged;
}

function relaxedSpotifyMatch(candidate, target, mode = "normal") {
  const targetTitle = wordSet(target.title);
  const candidateTitle = wordSet(candidate.title);

  if (!targetTitle.size || !candidateTitle.size) return false;

  let hits = 0;
  for (const word of targetTitle) {
    if (candidateTitle.has(word)) hits += 1;
  }

  const ratio = hits / targetTitle.size;
  if (ratio < 0.72) return false;

  const text = normalizeText(`${candidate.title} ${candidate.artist}`);

  for (const term of VIDEO_TERMS) {
    if (text.includes(term)) return false;
  }

  for (const term of BAD_VERSION_TERMS) {
    if (
      text.includes(term) &&
      !normalizeText(target.title).includes(term) &&
      !requestedVersionAllows(term, `${target.title} ${target.artist}`, mode)
    ) {
      return false;
    }
  }

  if (target.durationMs > 0 && candidate.durationMs > 0) {
    const diff = Math.abs(target.durationMs - candidate.durationMs);
    if (diff > 35_000) return false;
  }

  return true;
}

async function searchYoutubeCandidates(
  query,
  mode = "normal",
  count = SEARCH_RESULTS
) {
  const cacheKey = `${mode}:${normalizeText(query)}:${count}`;
  const cached = searchCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let fast = [];

  try {
    fast = await searchViaInnertube(query, mode, count);
  } catch (error) {
    // A stale InnerTube session can make the first search fast and later
    // searches appear to hang. Drop it on ANY fast-search failure so the next
    // request gets a fresh session instead of reusing a sick one.
    innertubePromise = null;
    console.warn(`[fast search reset/fallback] ${error.message}`);
  }

  // YouTube.js/YouTube Music is the normal search engine now. yt-dlp remains
  // a fallback, so provider/search hiccups do not turn into silent searches.
  let combined = fast;

  if (!combined.length) {
    const effective =
      mode === "normal"
        ? `${query} official audio`.trim()
        : `${query} ${searchSuffix(mode)}`.trim();

    const result = await runYtDlpJson(
      `ytsearch${Math.min(count, 6)}:${effective}`,
      ["--flat-playlist", "--playlist-end", String(Math.min(count, 6))],
      SEARCH_TIMEOUT_MS
    );

    const fallback = (Array.isArray(result?.entries) ? result.entries : [])
      .map((entry) =>
        youtubeEntryToTrack(entry, {
          mode,
          originalQuery: query,
        })
      )
      .filter((item) => item.url && item.title !== "Unknown title");

    combined = mergeUniqueTracks(fast, fallback);
  }

  const value = combined.slice(0, count);

  searchCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  pruneTimedCache(searchCache, 240);

  return value;
}

async function rankYoutubeCandidates(query, mode = "normal", target = null) {
  const candidates = await searchYoutubeCandidates(
    query,
    mode,
    SEARCH_RESULTS
  );

  let pool = target
    ? candidates.filter((item) => safeSpotifyMatch(item, target, mode))
    : candidates;

  if (target && !pool.length) {
    pool = candidates.filter((item) =>
      relaxedSpotifyMatch(item, target, mode)
    );
  }

  if (!target) {
    const cleanPool = pool.filter(
      (item) =>
        !candidateHasVideoTerm(item) &&
        !candidateHasUnwantedVersion(item, query, mode)
    );

    // Prefer the clean set, but never turn an otherwise valid search into
    // "nothing found" just because every candidate has a cosmetic label.
    if (cleanPool.length) pool = cleanPool;
  }

  return pool
    .map((item, index) => ({
      item,
      index,
      score: scoreCandidate(item, query, mode, target),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

export async function searchYoutube(query, mode = "normal", target = null) {
  const ranked = await rankYoutubeCandidates(query, mode, target);
  return ranked[0] || null;
}

async function importSpotify(value, mode = "normal") {
  const url = cleanSpotifyUrl(value);
  const kind = spotifyKind(url);

  if (!["track", "playlist", "album"].includes(kind)) {
    throw new Error("Use a Spotify track, album, or playlist URL.");
  }

  const details = await withTimeout(
    spotify.getDetails(url),
    SPOTIFY_TIMEOUT_MS,
    "Spotify metadata"
  );

  const preview = details?.preview || null;
  const tracks = Array.isArray(details?.tracks) ? details.tracks : [];
  const fallbackCover = preview?.image || "";

  if (kind === "track") {
    const raw = tracks[0] || preview;
    const item = spotifyTrackToItem(raw, url, fallbackCover, mode);

    if (preview) {
      item.title = preview.title || preview.track || item.title;
      item.artist = preview.artist || item.artist;
      item.cover = preview.image || item.cover;
      item.url = preview.link || item.url || url;
    }

    return {
      kind: "single",
      title: item.title,
      source: "spotify",
      sourceUrl: url,
      cover: item.cover,
      tracks: [item],
    };
  }

  const items = tracks
    .map((raw) => spotifyTrackToItem(raw, url, fallbackCover, mode))
    .filter((item) => item.title !== "Unknown title");

  if (!items.length) {
    throw new Error("Spotify returned no usable tracks for this collection.");
  }

  return {
    kind: "playlist",
    title: preview?.title || (kind === "album" ? "Spotify album" : "Spotify playlist"),
    source: "spotify",
    sourceUrl: url,
    cover: fallbackCover,
    tracks: items.slice(0, 100),
  };
}

async function importYouTube(value, mode = "normal") {
  const result = await runYtDlpJson(
    value,
    ["--flat-playlist", "--playlist-end", "200"],
    PLAYLIST_TIMEOUT_MS
  );

  if (Array.isArray(result?.entries) && result.entries.length) {
    const tracks = result.entries
      .map((entry) => youtubeEntryToTrack(entry, { mode, originalQuery: value }))
      .filter((item) => item.url)
      .slice(0, 200);

    return {
      kind: "playlist",
      title: result.title || result.playlist_title || "YouTube playlist",
      source: "youtube",
      sourceUrl: value,
      cover: result?.thumbnail || result?.thumbnails?.at?.(-1)?.url || tracks[0]?.cover || "",
      tracks,
    };
  }

  let item = youtubeEntryToTrack(result, { mode, originalQuery: value });
  if (!item.url) throw new Error("YouTube link returned no playable track metadata.");

  // A pasted YouTube URL identifies the song, but normal playback should still
  // prefer the clean audio/Topic upload rather than blindly accepting a music
  // video with cinematic intros/outros. Slowed/sped modes similarly resolve a
  // matching altered version. If no safe equivalent exists, keep the exact
  // link as a graceful fallback rather than failing the user's request.
  try {
    const titleQuery = stripSearchDecorators(item.title);
    const artistQuery = cleanChannelForSearch(item.artist);
    const effectiveQuery = `${artistQuery} ${titleQuery}`.trim() || item.title;
    const ranked = await rankYoutubeCandidates(effectiveQuery, mode, null);
    const originalCanonical = canonicalSongTitle(item.title);
    const replacement = ranked.find((candidate) => {
      const candidateCanonical = canonicalSongTitle(candidate.title);
      if (!candidateCanonical || !originalCanonical) return false;

      const left = wordSet(originalCanonical);
      const right = wordSet(candidateCanonical);
      let hits = 0;
      for (const word of left) if (right.has(word)) hits += 1;
      const overlap = hits / Math.max(1, Math.max(left.size, right.size));
      return overlap >= 0.62;
    });

    if (replacement) {
      item = cleanTrack({
        ...replacement,
        originalQuery: value,
        mode,
      });
    }
  } catch (error) {
    console.warn(`[youtube audio preference] ${error.message}`);
  }

  return {
    kind: "single",
    title: item.title,
    source: "youtube",
    sourceUrl: value,
    cover: item.cover,
    tracks: [item],
  };
}

export async function resolveInput(value, mode = "normal") {
  const query = String(value || "").trim();
  if (!query) throw new Error("Search is empty.");

  if (isSpotifyUrl(query)) return importSpotify(query, mode);
  if (isYouTubeUrl(query)) return importYouTube(query, mode);

  if (isHttpUrl(query)) {
    throw new Error("Only Spotify and YouTube links are supported here.");
  }

  const ranked = await rankYoutubeCandidates(query, mode, null);
  const item = ranked[0];

  if (!item) {
    throw new Error("No usable YouTube music result was found.");
  }

  return {
    kind: "single",
    title: item.title,
    source: "youtube",
    sourceUrl: "",
    cover: item.cover,
    tracks: [item],
    alternates: ranked.slice(1, 4),
  };
}

export async function searchMusic(value, mode = "normal", limit = 8) {
  const query = String(value || "").trim();
  if (!query) {
    return {
      kind: "search",
      title: "",
      source: "",
      sourceUrl: "",
      total: 0,
      results: [],
    };
  }

  const safeLimit = Math.max(1, Math.min(12, Number(limit || 8) || 8));

  if (isHttpUrl(query) && !isSpotifyUrl(query) && !isYouTubeUrl(query)) {
    throw new Error("Only Spotify and YouTube links are supported here.");
  }

  if (isSpotifyUrl(query)) {
    const imported = await importSpotify(query, mode);
    let results = imported.tracks.slice(0, safeLimit);

    // A single Spotify track can be fully mapped to its YouTube audio source
    // while the user is still looking at the dropdown. Clicking Play later can
    // therefore skip another metadata/search round-trip.
    if (imported.kind === "single" && results[0]) {
      try {
        results = [await preparePlayableTrack(results[0])];
      } catch {}
    }

    return {
      kind: imported.kind,
      title: imported.title,
      source: imported.source,
      sourceUrl: imported.sourceUrl,
      total: imported.tracks.length,
      results,
    };
  }

  if (isYouTubeUrl(query)) {
    const imported = await importYouTube(query, mode);
    return {
      kind: imported.kind,
      title: imported.title,
      source: imported.source,
      sourceUrl: imported.sourceUrl,
      total: imported.tracks.length,
      results: imported.tracks.slice(0, safeLimit),
    };
  }

  const ranked = await rankYoutubeCandidates(query, mode, null);
  return {
    kind: "search",
    title: query,
    source: "youtube",
    sourceUrl: "",
    total: ranked.length,
    results: ranked.slice(0, safeLimit),
  };
}

async function getSpotifyTrackPreview(url) {
  const key = cleanSpotifyUrl(url);
  const cached = spotifyPreviewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await withTimeout(
    spotify.getPreview(key),
    SPOTIFY_TIMEOUT_MS,
    "Spotify track metadata"
  );

  spotifyPreviewCache.set(key, {
    value,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
  pruneTimedCache(spotifyPreviewCache, 160);

  return value;
}

async function enrichSpotifyTrack(raw) {
  const item = cleanTrack(raw);
  if (item.source !== "spotify" || spotifyKind(item.url) !== "track") return item;

  try {
    const preview = await getSpotifyTrackPreview(item.url);
    return cleanTrack({
      ...item,
      title: preview?.title || preview?.track || item.title,
      artist: preview?.artist || item.artist,
      cover: preview?.image || item.cover,
      url: preview?.link || item.url,
    });
  } catch {
    return item;
  }
}

export async function ensureYoutubeItem(raw) {
  let item = cleanTrack(raw);

  if (item.source.startsWith("phase2:")) {
    const query = item.source.slice("phase2:".length).trim() || item.title;
    const matched = await searchYoutube(query, "normal", null);
    if (!matched) throw new Error(`No safe audio result for ${item.title}`);
    return matched;
  }

  if (item.youtubeUrl && isYouTubeUrl(item.youtubeUrl)) return item;

  if (item.source === "youtube" && isYouTubeUrl(item.url)) {
    return cleanTrack({ ...item, youtubeUrl: item.url });
  }

  if (item.source === "spotify") {
    item = await enrichSpotifyTrack(item);
  }

  const query = `${item.artist} ${item.title}`.trim();
  const matched = await searchYoutube(
    query,
    ["normal", "slow", "fast"].includes(item.mode) ? item.mode : "normal",
    item.source === "spotify" ? item : null
  );

  if (!matched) {
    throw new Error(`No safe audio match for ${item.artist} - ${item.title}`);
  }

  return cleanTrack({
    ...item,
    youtubeUrl: matched.youtubeUrl || matched.url,
    durationMs: item.durationMs || matched.durationMs,
    cover: item.cover || matched.cover,
  });
}

export async function preparePlayableTrack(raw) {
  const identity = trackIdentity(raw);
  const key = identity || `${normalizeText(raw?.artist)}::${normalizeText(raw?.title)}`;

  const cached = prepareCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const promise = ensureYoutubeItem(raw);
  prepareCache.set(key, { value: promise, expiresAt: Date.now() + 20 * 60 * 1000 });
  pruneTimedCache(prepareCache, 240);

  try {
    const value = await promise;
    prepareCache.set(key, { value: Promise.resolve(value), expiresAt: Date.now() + 20 * 60 * 1000 });
    pruneTimedCache(prepareCache, 240);
    return value;
  } catch (error) {
    prepareCache.delete(key);
    throw error;
  }
}

function canonicalSongTitle(value) {
  let text = normalizeText(value);
  for (const term of [...BAD_VERSION_TERMS, ...VIDEO_TERMS, "official audio", "audio", "lyrics", "visualizer"]) {
    text = text.replaceAll(normalizeText(term), " ");
  }
  return normalizeText(text);
}

function sameSong(left, right) {
  if (!left || !right) return false;
  if (trackIdentity(left) && trackIdentity(left) === trackIdentity(right)) return true;

  const leftTitle = canonicalSongTitle(left.title);
  const rightTitle = canonicalSongTitle(right.title);
  if (!leftTitle || !rightTitle) return false;

  const leftArtistWords = wordSet(left.artist);
  const rightAllWords = wordSet(`${right.artist} ${right.title}`);
  let artistOverlap = leftArtistWords.size === 0;
  for (const word of leftArtistWords) {
    if (rightAllWords.has(word)) {
      artistOverlap = true;
      break;
    }
  }

  if (!artistOverlap) return false;
  if (leftTitle === rightTitle) return true;

  const leftWords = wordSet(leftTitle);
  const rightWords = wordSet(rightTitle);
  if (!leftWords.size || !rightWords.size) return false;

  let hits = 0;
  for (const word of leftWords) if (rightWords.has(word)) hits += 1;
  const overlap = hits / Math.max(leftWords.size, rightWords.size);
  return overlap >= 0.82;
}

function radioAllowed(candidate, seed, avoid) {
  if (!candidate?.url) return false;
  if (sameSong(candidate, seed)) return false;

  const candidateText = normalizeText(`${candidate.title} ${candidate.artist}`);
  const seedText = normalizeText(`${seed.title} ${seed.artist}`);
  if (RADIO_REJECT_TERMS.some((term) => candidateText.includes(term))) return false;
  if (candidateText.includes("phonk") && !seedText.includes("phonk")) return false;
  if (VIDEO_TERMS.some((term) => candidateText.includes(term))) return false;

  for (const existing of avoid) {
    if (trackIdentity(candidate) === trackIdentity(existing) || sameSong(candidate, existing)) {
      return false;
    }
  }

  return true;
}

async function relatedFromMix(seed) {
  const youtube = await preparePlayableTrack(seed);
  const id = youtubeVideoId(youtube.youtubeUrl || youtube.url);
  if (!id) return [];

  const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
  const result = await runYtDlpJson(
    mixUrl,
    ["--flat-playlist", "--playlist-end", String(RADIO_CANDIDATES)],
    PLAYLIST_TIMEOUT_MS
  );

  return (Array.isArray(result?.entries) ? result.entries : [])
    .map((entry) => youtubeEntryToTrack(entry, { mode: "normal" }))
    .filter((item) => item.url);
}

async function relatedFallback(seed) {
  const query = `${seed.artist} ${seed.title} similar songs`;
  const result = await runYtDlpJson(
    `ytsearch${RADIO_CANDIDATES}:${query}`,
    ["--flat-playlist", "--playlist-end", String(RADIO_CANDIDATES)],
    SEARCH_TIMEOUT_MS
  );

  return (Array.isArray(result?.entries) ? result.entries : [])
    .map((entry) => youtubeEntryToTrack(entry, { mode: "normal", originalQuery: query }))
    .filter((item) => item.url);
}

export async function buildRadio(seed, avoidTracks = [], targetCount = 8) {
  const preparedSeed = await preparePlayableTrack(seed);
  let candidates = [];

  try {
    candidates = await relatedFromMix(preparedSeed);
  } catch (error) {
    console.warn("[radio mix]", error.message);
  }

  if (candidates.length < targetCount) {
    try {
      candidates.push(...(await relatedFallback(preparedSeed)));
    } catch (error) {
      console.warn("[radio fallback]", error.message);
    }
  }

  const avoid = [preparedSeed, ...avoidTracks].filter(Boolean);
  const result = [];
  const artistCounts = new Map();

  for (const candidate of candidates) {
    if (!radioAllowed(candidate, preparedSeed, [...avoid, ...result])) continue;

    const artist = normalizeText(candidate.artist);
    const count = artistCounts.get(artist) || 0;
    if (artist && count >= 2) continue;

    result.push(candidate);
    if (artist) artistCounts.set(artist, count + 1);
    if (result.length >= targetCount) break;
  }

  return result;
}

export function resolverStatus() {
  return {
    ytDlpReady: fs.existsSync(YTDLP_PATH),
    ytDlpPath: YTDLP_PATH,
    cookiesPresent: Boolean(configuredCookie && fs.existsSync(COOKIE_FILE)),
    spotifyMetadata: true,
    fastSearch: "YouTube Music / reset-on-stall Innertube with yt-dlp fallback",
    searchResults: SEARCH_RESULTS,
  };
}
