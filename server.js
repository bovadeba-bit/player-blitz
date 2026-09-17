import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import express from "express";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import { WebSocket, WebSocketServer } from "ws";

import {
  buildRadio,
  preparePlayableTrack,
  resolveInput,
  resolverStatus,
  searchMusic,
  trackIdentity,
  warmSearchEngine,
} from "./music/resolver.js";

import {
  DiscordAudioEngine,
  audioRuntimeStatus,
} from "./music/audio-engine.js";

// ============================================================
// CONFIG
// ============================================================

const TOKEN = String(process.env.DISCORD_TOKEN || "")
  .replace(/^\uFEFF/, "")
  .trim()
  .replace(/^Bot\s+/i, "");

const CLIENT_ID = String(process.env.VITE_DISCORD_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || "").trim();
const PREFIX = String(process.env.BOT_PREFIX || "!").trim() || "!";
const PORT = Number(process.env.PORT || 3001);

if (!TOKEN) {
  console.error("[fatal] DISCORD_TOKEN is missing.");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("[fatal] VITE_DISCORD_CLIENT_ID is missing.");
  process.exit(1);
}

if (!CLIENT_SECRET) {
  console.error(
    "[fatal] DISCORD_CLIENT_SECRET is missing. Copy it from Developer Portal -> OAuth2 into .env."
  );
  process.exit(1);
}

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "player.sqlite");
const DIST_DIR = path.resolve("dist");

fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// SQLITE
// ============================================================

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    youtube_url TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'unknown',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS liked_tracks (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, track_id),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_playlists_owner
  ON playlists(guild_id, owner_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position
  ON playlist_tracks(playlist_id, position ASC);

  CREATE TABLE IF NOT EXISTS guild_player_state (
    guild_id TEXT PRIMARY KEY,
    player_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS launcher_messages (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Phase 3 database migration: preserve a Phase 2 database if the user copies
// data/player.sqlite into this folder. SQLite has no ADD COLUMN IF NOT EXISTS,
// so inspect the table before adding resolver metadata.
function ensureTrackColumn(name, ddl) {
  const columns = db.prepare(`PRAGMA table_info(tracks)`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${ddl}`);
  }
}

ensureTrackColumn("youtube_url", "TEXT NOT NULL DEFAULT ''");

function runTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function compactText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function musicMode(value) {
  return ["normal", "slow", "fast"].includes(value) ? value : "normal";
}

function normalizeUrl(value) {
  const raw = compactText(value, 1200);
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeTrack(raw) {
  const title = compactText(raw?.title, 240);
  const artist = compactText(raw?.artist, 180);
  const url = normalizeUrl(raw?.url);
  const youtubeUrl = normalizeUrl(raw?.youtubeUrl);
  const cover = normalizeUrl(raw?.cover);
  const source = compactText(raw?.source || "unknown", 50) || "unknown";
  const durationMs = Math.max(
    0,
    Math.min(Number(raw?.durationMs || 0) || 0, 24 * 60 * 60 * 1000)
  );

  if (!title) {
    throw new Error("Track title is required.");
  }

  const identity = url
    ? `url:${url.toLowerCase()}`
    : `meta:${title.toLowerCase()}::${artist.toLowerCase()}::${source.toLowerCase()}`;

  const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);

  return {
    key,
    title,
    artist,
    url,
    youtubeUrl,
    cover,
    durationMs,
    source,
  };
}

function trackRowToObject(row) {
  return {
    id: Number(row.id),
    key: row.track_key,
    title: row.title,
    artist: row.artist,
    url: row.url,
    youtubeUrl: row.youtube_url || "",
    cover: row.cover,
    durationMs: Number(row.duration_ms || 0),
    source: row.source,
  };
}

const insertTrackStmt = db.prepare(`
  INSERT INTO tracks (
    track_key, title, artist, url, youtube_url, cover, duration_ms, source, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(track_key) DO UPDATE SET
    title = excluded.title,
    artist = excluded.artist,
    url = CASE WHEN excluded.url != '' THEN excluded.url ELSE tracks.url END,
    youtube_url = CASE WHEN excluded.youtube_url != '' THEN excluded.youtube_url ELSE tracks.youtube_url END,
    cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE tracks.cover END,
    duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE tracks.duration_ms END,
    source = CASE WHEN excluded.source != '' THEN excluded.source ELSE tracks.source END,
    updated_at = excluded.updated_at
`);

const selectTrackByKeyStmt = db.prepare(`
  SELECT id, track_key, title, artist, url, youtube_url, cover, duration_ms, source
  FROM tracks
  WHERE track_key = ?
`);

function ensureTrack(raw) {
  const track = normalizeTrack(raw);
  const now = Date.now();

  insertTrackStmt.run(
    track.key,
    track.title,
    track.artist,
    track.url,
    track.youtubeUrl,
    track.cover,
    Math.round(track.durationMs),
    track.source,
    now,
    now
  );

  const row = selectTrackByKeyStmt.get(track.key);
  return trackRowToObject(row);
}

function getLibraryCounts(guildId, userId) {
  const liked = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM liked_tracks
      WHERE guild_id = ? AND user_id = ?
    `)
    .get(guildId, userId);

  const playlists = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM playlists
      WHERE guild_id = ? AND owner_id = ?
    `)
    .get(guildId, userId);

  return {
    likedCount: Number(liked?.count || 0),
    playlistCount: Number(playlists?.count || 0),
  };
}

function getGuildLibraryCountMaps(guildId) {
  const likedRows = db
    .prepare(`
      SELECT user_id, COUNT(*) AS count
      FROM liked_tracks
      WHERE guild_id = ?
      GROUP BY user_id
    `)
    .all(guildId);

  const playlistRows = db
    .prepare(`
      SELECT owner_id AS user_id, COUNT(*) AS count
      FROM playlists
      WHERE guild_id = ?
      GROUP BY owner_id
    `)
    .all(guildId);

  return {
    liked: new Map(likedRows.map((row) => [row.user_id, Number(row.count || 0)])),
    playlists: new Map(
      playlistRows.map((row) => [row.user_id, Number(row.count || 0)])
    ),
  };
}

function getLibrary(guildId, userId) {
  const likedRows = db
    .prepare(`
      SELECT
        t.id, t.track_key, t.title, t.artist, t.url, t.youtube_url, t.cover,
        t.duration_ms, t.source, l.created_at
      FROM liked_tracks l
      JOIN tracks t ON t.id = l.track_id
      WHERE l.guild_id = ? AND l.user_id = ?
      ORDER BY l.created_at DESC
    `)
    .all(guildId, userId);

  const playlistRows = db
    .prepare(`
      SELECT id, name, created_at, updated_at
      FROM playlists
      WHERE guild_id = ? AND owner_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(guildId, userId);

  const trackStmt = db.prepare(`
    SELECT
      t.id, t.track_key, t.title, t.artist, t.url, t.youtube_url, t.cover,
      t.duration_ms, t.source, pt.position
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC, pt.created_at ASC
  `);

  const playlists = playlistRows.map((playlist) => ({
    id: Number(playlist.id),
    name: playlist.name,
    createdAt: Number(playlist.created_at),
    updatedAt: Number(playlist.updated_at),
    tracks: trackStmt.all(playlist.id).map(trackRowToObject),
  }));

  return {
    userId,
    liked: likedRows.map(trackRowToObject),
    playlists,
  };
}

function toggleLike(guildId, userId, rawTrack) {
  const track = ensureTrack(rawTrack);

  const existing = db
    .prepare(`
      SELECT 1 AS present
      FROM liked_tracks
      WHERE guild_id = ? AND user_id = ? AND track_id = ?
    `)
    .get(guildId, userId, track.id);

  if (existing) {
    db.prepare(`
      DELETE FROM liked_tracks
      WHERE guild_id = ? AND user_id = ? AND track_id = ?
    `).run(guildId, userId, track.id);
  } else {
    db.prepare(`
      INSERT INTO liked_tracks(guild_id, user_id, track_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(guildId, userId, track.id, Date.now());
  }

  return {
    liked: !existing,
    track,
    library: getLibrary(guildId, userId),
  };
}

function createPlaylist(guildId, userId, name) {
  const cleanName = compactText(name, 80);
  if (!cleanName) {
    throw new Error("Playlist name is required.");
  }

  const now = Date.now();
  const result = db
    .prepare(`
      INSERT INTO playlists(guild_id, owner_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(guildId, userId, cleanName, now, now);

  return Number(result.lastInsertRowid);
}

function assertOwnedPlaylist(guildId, userId, playlistId) {
  const playlist = db
    .prepare(`
      SELECT id, name
      FROM playlists
      WHERE id = ? AND guild_id = ? AND owner_id = ?
    `)
    .get(playlistId, guildId, userId);

  if (!playlist) {
    const error = new Error("Playlist not found or not owned by you.");
    error.statusCode = 404;
    throw error;
  }

  return playlist;
}

function addTrackToPlaylist(guildId, userId, playlistId, rawTrack) {
  assertOwnedPlaylist(guildId, userId, playlistId);
  const track = ensureTrack(rawTrack);

  const maxRow = db
    .prepare(`
      SELECT COALESCE(MAX(position), -1) AS max_position
      FROM playlist_tracks
      WHERE playlist_id = ?
    `)
    .get(playlistId);

  const nextPosition = Number(maxRow?.max_position ?? -1) + 1;
  const now = Date.now();

  db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position, created_at)
    VALUES (?, ?, ?, ?)
  `).run(playlistId, track.id, nextPosition, now);

  db.prepare(`
    UPDATE playlists SET updated_at = ? WHERE id = ?
  `).run(now, playlistId);

  return getLibrary(guildId, userId);
}

function removeTrackFromPlaylist(guildId, userId, playlistId, trackKey) {
  assertOwnedPlaylist(guildId, userId, playlistId);

  const track = selectTrackByKeyStmt.get(trackKey);
  if (!track) return getLibrary(guildId, userId);

  db.prepare(`
    DELETE FROM playlist_tracks
    WHERE playlist_id = ? AND track_id = ?
  `).run(playlistId, track.id);

  db.prepare(`
    UPDATE playlists SET updated_at = ? WHERE id = ?
  `).run(Date.now(), playlistId);

  return getLibrary(guildId, userId);
}

// ============================================================
// SHARED PLAYER STATE + PHASE 3 CANONICAL QUEUE BRAIN
// ============================================================

const RADIO_TARGET = 8;
const RADIO_REFILL_AT = 3;
const playerStates = new Map();
const radioGenerations = new Map();
const guildIntentGenerations = new Map();
const guildActionChains = new Map();

function createEmptyPlayerState() {
  return {
    current: null,
    playing: false,
    positionMs: 0,
    updatedAt: Date.now(),
    history: [],
    playNext: [],
    baseQueue: [],
    baseKind: "none",
    radioFilling: false,
  };
}

function sanitizePersistedPlayerState(raw) {
  const empty = createEmptyPlayerState();
  if (!raw || typeof raw !== "object") return empty;

  const safeTrack = (value) => {
    if (!value?.title) return null;
    try { return normalizeTrack(value); } catch { return null; }
  };

  const cleanArray = (value, max = 500) =>
    Array.isArray(value) ? value.map(safeTrack).filter(Boolean).slice(0, max) : [];

  return {
    current: safeTrack(raw.current),
    playing: Boolean(raw.playing && raw.current),
    positionMs: Math.max(0, Number(raw.positionMs || 0) || 0),
    updatedAt: Number(raw.updatedAt || Date.now()) || Date.now(),
    history: cleanArray(raw.history, 50),
    playNext: cleanArray(raw.playNext, 500),
    baseQueue: cleanArray(raw.baseQueue, 500),
    baseKind: ["playlist", "radio", "none"].includes(raw.baseKind)
      ? raw.baseKind
      : "none",
    radioFilling: false,
  };
}

function loadPlayerState(guildId) {
  if (playerStates.has(guildId)) return playerStates.get(guildId);

  const row = db
    .prepare(`SELECT player_json FROM guild_player_state WHERE guild_id = ?`)
    .get(guildId);

  let state = createEmptyPlayerState();
  if (row?.player_json) {
    try { state = sanitizePersistedPlayerState(JSON.parse(row.player_json)); } catch {}
  }

  // Phase 2 deliberately used fake search-track metadata. Do not resurrect a
  // fake CURRENT track after upgrading; library placeholders are preserved and
  // are upgraded lazily when the user plays them in Phase 3.
  if (String(state.current?.source || "").startsWith("phase2:")) {
    state.current = null;
    state.playing = false;
    state.positionMs = 0;
    state.playNext = [];
    state.baseQueue = [];
    state.baseKind = "none";
  }

  // A voice connection cannot survive a Node process restart. Preserve the
  // current track and saved position, but freeze it until someone presses Play.
  state.playing = false;
  state.updatedAt = Date.now();

  playerStates.set(guildId, state);
  return state;
}

function savePlayerState(guildId, state) {
  db.prepare(`
    INSERT INTO guild_player_state(guild_id, player_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      player_json = excluded.player_json,
      updated_at = excluded.updated_at
  `).run(guildId, JSON.stringify({ ...state, radioFilling: false }), Date.now());
}

function materializePosition(state) {
  if (state.current && state.playing) {
    const delta = Math.max(0, Date.now() - Number(state.updatedAt || Date.now()));
    state.positionMs += delta;
    if (state.current.durationMs > 0) {
      state.positionMs = Math.min(state.positionMs, state.current.durationMs);
    }
  }
  state.updatedAt = Date.now();
}

function pushHistory(state, track) {
  if (!track) return;
  state.history.push(normalizeTrack(track));
  if (state.history.length > 50) {
    state.history.splice(0, state.history.length - 50);
  }
}

function snapshotPlayerState(state) {
  let positionMs = Number(state.positionMs || 0);
  if (state.current && state.playing) {
    positionMs += Math.max(0, Date.now() - Number(state.updatedAt || Date.now()));
  }
  if (state.current?.durationMs > 0) {
    positionMs = Math.min(positionMs, state.current.durationMs);
  }

  return {
    current: state.current,
    playing: state.playing,
    positionMs,
    history: state.history,
    playNext: state.playNext,
    baseQueue: state.baseQueue,
    baseKind: state.baseKind,
    radioFilling: Boolean(state.radioFilling),
    snapshotAt: Date.now(),
  };
}

function nextIntentGeneration(guildId) {
  const generation = (guildIntentGenerations.get(guildId) || 0) + 1;
  guildIntentGenerations.set(guildId, generation);
  return generation;
}

function currentIntentGeneration(guildId) {
  return guildIntentGenerations.get(guildId) || 0;
}

function invalidateRadio(guildId) {
  const generation = (radioGenerations.get(guildId) || 0) + 1;
  radioGenerations.set(guildId, generation);
  const state = loadPlayerState(guildId);
  state.radioFilling = false;
  return generation;
}

function currentRadioGeneration(guildId) {
  return radioGenerations.get(guildId) || 0;
}

async function withGuildActionLock(guildId, fn) {
  const previous = guildActionChains.get(guildId) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  guildActionChains.set(guildId, current);

  try {
    return await current;
  } finally {
    if (guildActionChains.get(guildId) === current) {
      guildActionChains.delete(guildId);
    }
  }
}

function replaceTrackReferencesForGuild(guildId, oldTrackKey, preparedTrack) {
  if (!oldTrackKey || !preparedTrack?.title) return [];

  const oldRow = selectTrackByKeyStmt.get(oldTrackKey);
  if (!oldRow) return [];

  const newTrack = ensureTrack(preparedTrack);
  if (Number(oldRow.id) === Number(newTrack.id)) return [];

  const affected = new Set();

  runTransaction(() => {
    const likedRows = db.prepare(`
      SELECT user_id FROM liked_tracks
      WHERE guild_id = ? AND track_id = ?
    `).all(guildId, oldRow.id);

    for (const row of likedRows) {
      affected.add(row.user_id);
      db.prepare(`
        INSERT OR IGNORE INTO liked_tracks(guild_id, user_id, track_id, created_at)
        SELECT guild_id, user_id, ?, created_at
        FROM liked_tracks
        WHERE guild_id = ? AND user_id = ? AND track_id = ?
      `).run(newTrack.id, guildId, row.user_id, oldRow.id);
    }

    db.prepare(`
      DELETE FROM liked_tracks WHERE guild_id = ? AND track_id = ?
    `).run(guildId, oldRow.id);

    const playlistRows = db.prepare(`
      SELECT pt.playlist_id, pt.position, pt.created_at, p.owner_id
      FROM playlist_tracks pt
      JOIN playlists p ON p.id = pt.playlist_id
      WHERE p.guild_id = ? AND pt.track_id = ?
    `).all(guildId, oldRow.id);

    for (const row of playlistRows) {
      affected.add(row.owner_id);
      db.prepare(`
        INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position, created_at)
        VALUES (?, ?, ?, ?)
      `).run(row.playlist_id, newTrack.id, row.position, row.created_at);
    }

    for (const row of playlistRows) {
      db.prepare(`
        DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?
      `).run(row.playlist_id, oldRow.id);
    }
  });

  return [...affected];
}

async function prepareTrackForGuild(guildId, rawTrack) {
  const raw = rawTrack || {};
  const prepared = await preparePlayableTrack(raw);

  if (String(raw.source || "").startsWith("phase2:") && raw.key) {
    const affectedUsers = replaceTrackReferencesForGuild(guildId, raw.key, prepared);
    for (const userId of affectedUsers) {
      broadcastGuild(guildId, {
        type: "library_changed",
        userId,
        counts: getLibraryCounts(guildId, userId),
      });
    }
  }

  return normalizeTrack(prepared);
}

function setSingleState(guildId, preparedTrack) {
  const state = loadPlayerState(guildId);
  materializePosition(state);
  if (state.current) pushHistory(state, state.current);

  state.current = normalizeTrack(preparedTrack);
  // Phase 4 only marks `playing` true after Discord voice actually starts.
  state.playing = false;
  state.positionMs = 0;
  state.updatedAt = Date.now();
  state.playNext = [];
  state.baseQueue = [];
  state.baseKind = "radio";
  state.radioFilling = false;

  savePlayerState(guildId, state);
  return state;
}

function setCollectionState(guildId, firstPrepared, restTracks) {
  const state = loadPlayerState(guildId);
  materializePosition(state);
  if (state.current) pushHistory(state, state.current);

  state.current = normalizeTrack(firstPrepared);
  // Phase 4 only marks `playing` true after Discord voice actually starts.
  state.playing = false;
  state.positionMs = 0;
  state.updatedAt = Date.now();
  state.playNext = [];
  state.baseQueue = (restTracks || []).map(normalizeTrack).slice(0, 500);
  state.baseKind = "playlist";
  state.radioFilling = false;

  savePlayerState(guildId, state);
  return state;
}

function uniqueAppendRadio(state, candidates) {
  const known = new Set(
    [state.current, ...state.history.slice(-12), ...state.playNext, ...state.baseQueue]
      .filter(Boolean)
      .map(trackIdentity)
  );

  for (const candidate of candidates) {
    const normalized = normalizeTrack(candidate);
    const identity = trackIdentity(normalized);
    if (!identity || known.has(identity)) continue;
    state.baseQueue.push(normalized);
    known.add(identity);
    if (state.baseQueue.length >= RADIO_TARGET) break;
  }
}

function broadcastPlayer(guildId, actorId = "") {
  const player = snapshotPlayerState(loadPlayerState(guildId));
  broadcastGuild(guildId, { type: "player_state", player, actorId });
  return player;
}

function scheduleRadioFill(guildId, seed, { newSession = false } = {}) {
  if (!seed) return;

  const generation = newSession ? invalidateRadio(guildId) : currentRadioGeneration(guildId);
  if (!radioGenerations.has(guildId)) radioGenerations.set(guildId, generation);

  const state = loadPlayerState(guildId);
  if (state.baseKind !== "radio") return;
  if (state.radioFilling || state.baseQueue.length >= RADIO_TARGET) return;

  state.radioFilling = true;
  broadcastPlayer(guildId);

  const avoid = [
    ...state.history.slice(-12),
    state.current,
    ...state.playNext,
    ...state.baseQueue,
  ].filter(Boolean);

  buildRadio(seed, avoid, RADIO_TARGET)
    .then((candidates) => {
      if (currentRadioGeneration(guildId) !== generation) return;
      const live = loadPlayerState(guildId);
      if (live.baseKind !== "radio") return;

      uniqueAppendRadio(live, candidates);
      live.radioFilling = false;
      savePlayerState(guildId, live);
      broadcastPlayer(guildId);
      scheduleUpcomingPrefetch(guildId);
    })
    .catch((error) => {
      console.error("[radio]", error.message);
      if (currentRadioGeneration(guildId) !== generation) return;
      const live = loadPlayerState(guildId);
      live.radioFilling = false;
      savePlayerState(guildId, live);
      broadcastPlayer(guildId);
    });
}

async function replaceWithSingle(guildId, rawTrack) {
  const prepared = await prepareTrackForGuild(guildId, rawTrack);
  invalidateRadio(guildId);
  const state = setSingleState(guildId, prepared);
  broadcastPlayer(guildId);
  return snapshotPlayerState(state);
}

async function replaceWithCollection(guildId, rawTracks) {
  const tracks = Array.isArray(rawTracks) ? rawTracks.filter((t) => t?.title).slice(0, 500) : [];
  if (!tracks.length) throw new Error("Playlist has no tracks.");

  const firstPrepared = await prepareTrackForGuild(guildId, tracks[0]);
  invalidateRadio(guildId);
  const state = setCollectionState(guildId, firstPrepared, tracks.slice(1));
  broadcastPlayer(guildId);
  return snapshotPlayerState(state);
}

async function enqueuePlayNext(guildId, rawTrack) {
  const prepared = await prepareTrackForGuild(guildId, rawTrack);
  const state = loadPlayerState(guildId);

  if (!state.current) {
    return replaceWithSingle(guildId, prepared);
  }

  state.playNext.push(normalizeTrack(prepared));
  if (state.playNext.length > 500) state.playNext.length = 500;
  savePlayerState(guildId, state);
  const player = broadcastPlayer(guildId);
  scheduleUpcomingPrefetch(guildId);
  return player;
}

async function advanceResolved(guildId) {
  const state = loadPlayerState(guildId);
  materializePosition(state);
  if (state.current) pushHistory(state, state.current);

  let next = null;
  let attempts = 0;

  while (!next && attempts < 12) {
    attempts += 1;
    const raw = state.playNext.length ? state.playNext.shift() : state.baseQueue.shift();
    if (!raw) break;

    try {
      next = await prepareTrackForGuild(guildId, raw);
    } catch (error) {
      console.warn(`[queue skip] ${raw.title}: ${error.message}`);
    }
  }

  state.current = next;
  state.positionMs = 0;
  state.playing = false;
  state.updatedAt = Date.now();
  state.radioFilling = false;

  let startNewRadio = false;

  if (next && state.baseKind === "playlist" && !state.baseQueue.length && !state.playNext.length) {
    state.baseKind = "radio";
    startNewRadio = true;
  } else if (!next && state.baseKind === "playlist") {
    state.baseKind = "none";
  }

  savePlayerState(guildId, state);
  broadcastPlayer(guildId);

  if (next && startNewRadio) {
    invalidateRadio(guildId);
  }

  return snapshotPlayerState(state);
}

function applySimplePlayerAction(guildId, action, payload) {
  const state = loadPlayerState(guildId);

  switch (action) {
    case "toggle_pause": {
      if (!state.current) break;
      materializePosition(state);
      state.playing = !state.playing;
      state.updatedAt = Date.now();
      break;
    }

    case "previous": {
      materializePosition(state);
      const previous = state.history.pop() || null;
      if (previous) {
        if (state.current) state.playNext.unshift(state.current);
        state.current = previous;
        state.positionMs = 0;
        state.playing = false;
        state.updatedAt = Date.now();
      }
      break;
    }

    case "remove_queue": {
      const kind = payload.kind === "priority" ? "priority" : "base";
      const index = Number(payload.index);
      if (Number.isInteger(index) && index >= 0) {
        if (kind === "priority") state.playNext.splice(index, 1);
        else state.baseQueue.splice(index, 1);
      }
      break;
    }

    case "clear": {
      invalidateRadio(guildId);
      Object.assign(state, createEmptyPlayerState());
      break;
    }

    default:
      throw new Error(`Unknown player action: ${action}`);
  }

  savePlayerState(guildId, state);
  return broadcastPlayer(guildId);
}

// ============================================================
// DISCORD BOT + REAL MEMBER LIST
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const memberListCache = new Map();
const MEMBER_CACHE_MS = 60_000;

function globalAvatarUrl(user) {
  // Discord Activities explicitly allow the global /avatars/ CDN path.
  // For users without a custom avatar, render initials in the client instead
  // of depending on the default /embed/avatars/ path.
  if (!user.avatar) return "";
  return user.displayAvatarURL({ extension: "png", size: 128 });
}

async function getGuildOrThrow(guildId) {
  if (!client.isReady()) {
    const error = new Error("Discord bot is still starting.");
    error.statusCode = 503;
    throw error;
  }

  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    const error = new Error("The bot is not installed in this server.");
    error.statusCode = 403;
    throw error;
  }

  return guild;
}

async function getBaseGuildMembers(guildId, force = false) {
  const cached = memberListCache.get(guildId);

  if (!force && cached && Date.now() - cached.at < MEMBER_CACHE_MS) {
    return cached.members;
  }

  const guild = await getGuildOrThrow(guildId);

  let collection;
  try {
    collection = await guild.members.fetch();
  } catch (error) {
    const wrapped = new Error(
      "Could not load server members. Enable Developer Portal -> Bot -> Server Members Intent, then restart the bot."
    );
    wrapped.statusCode = 503;
    wrapped.cause = error;
    throw wrapped;
  }

  const members = [...collection.values()]
    .filter((member) => !member.user.bot)
    .map((member) => ({
      id: member.id,
      name: compactText(member.displayName || member.user.globalName || member.user.username, 80),
      username: compactText(member.user.username, 80),
      avatarUrl: globalAvatarUrl(member.user),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  memberListCache.set(guildId, {
    at: Date.now(),
    members,
  });

  return members;
}

async function getDecoratedGuildMembers(guildId, currentUserId) {
  const members = await getBaseGuildMembers(guildId);
  const counts = getGuildLibraryCountMaps(guildId);

  return members
    .map((member) => ({
      ...member,
      likedCount: counts.liked.get(member.id) || 0,
      playlistCount: counts.playlists.get(member.id) || 0,
    }))
    .sort((a, b) => {
      if (a.id === currentUserId) return -1;
      if (b.id === currentUserId) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

async function assertGuildMember(guildId, userId) {
  const members = await getBaseGuildMembers(guildId);
  if (members.some((member) => member.id === userId)) return;

  const error = new Error("That user is not a member of this server.");
  error.statusCode = 404;
  throw error;
}

// ============================================================
// PHASE 4 DISCORD VOICE + REAL PLAYBACK
// ============================================================

function currentTrackIdentity(guildId) {
  const current = loadPlayerState(guildId).current;
  return current ? trackIdentity(current) : "";
}

const upcomingPrefetchTimers = new Map();
const delayedRadioTimers = new Map();

function scheduleUpcomingPrefetch(guildId) {
  const id = String(guildId);
  const previous = upcomingPrefetchTimers.get(id);
  if (previous) clearTimeout(previous);

  const expectedCurrent = currentTrackIdentity(id);

  const timer = setTimeout(() => {
    upcomingPrefetchTimers.delete(id);

    const state = loadPlayerState(id);
    if (
      !state.current ||
      trackIdentity(state.current) !== expectedCurrent
    ) {
      return;
    }

    // Only one background download at a time. Phase 4 previously started two
    // full-speed prefetches immediately, which could steal bandwidth from
    // Discord voice and sound like audio buffering.
    const track = state.playNext[0] || state.baseQueue[0];
    if (!track) return;

    audioEngine.prefetch(track).catch(() => {});
  }, 12_000);

  upcomingPrefetchTimers.set(id, timer);
}

function scheduleRadioAfterPlaybackStarts(
  guildId,
  seed,
  { delayMs = 2_500 } = {}
) {
  if (!seed) return;

  const id = String(guildId);
  const previous = delayedRadioTimers.get(id);
  if (previous) clearTimeout(previous);

  const expectedIdentity = trackIdentity(seed);

  const timer = setTimeout(() => {
    delayedRadioTimers.delete(id);

    const state = loadPlayerState(id);
    if (
      !state.current ||
      trackIdentity(state.current) !== expectedIdentity ||
      state.baseKind !== "radio" ||
      state.baseQueue.length >= RADIO_TARGET
    ) {
      return;
    }

    scheduleRadioFill(id, state.current);
  }, delayMs);

  delayedRadioTimers.set(id, timer);
}

async function waitForRadioAtTransition(guildId, seed) {
  let state = loadPlayerState(guildId);

  if (
    state.baseKind !== "radio" ||
    state.playNext.length ||
    state.baseQueue.length
  ) {
    return;
  }

  // A background radio fill normally finished minutes before the current
  // track ends. Give an in-flight fill a short chance before doing a blocking
  // fallback so radio does not stop just because the provider was slow.
  for (let i = 0; i < 10; i += 1) {
    if (!state.radioFilling) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = loadPlayerState(guildId);
    if (state.playNext.length || state.baseQueue.length) return;
  }

  if (state.playNext.length || state.baseQueue.length || state.baseKind !== "radio") {
    return;
  }

  const avoid = [
    ...state.history.slice(-12),
    seed,
    ...state.playNext,
    ...state.baseQueue,
  ].filter(Boolean);

  try {
    state.radioFilling = true;
    broadcastPlayer(guildId);
    const candidates = await buildRadio(seed, avoid, RADIO_TARGET);
    uniqueAppendRadio(state, candidates);
  } catch (error) {
    console.warn(`[radio transition] ${error.message}`);
  } finally {
    state.radioFilling = false;
    savePlayerState(guildId, state);
    broadcastPlayer(guildId);
  }
}

async function startCurrentAudio(
  guildId,
  userId = "",
  {
    seekMs = null,
    expectedIdentity = "",
    preserveEarlyRetry = false,
  } = {}
) {
  const state = loadPlayerState(guildId);
  if (!state.current) return snapshotPlayerState(state);

  const identity = trackIdentity(state.current);
  if (expectedIdentity && identity !== expectedIdentity) {
    return snapshotPlayerState(state);
  }

  const startAt = Math.max(
    0,
    Number(seekMs == null ? state.positionMs : seekMs) || 0
  );

  state.playing = false;
  state.positionMs = startAt;
  state.updatedAt = Date.now();
  savePlayerState(guildId, state);
  broadcastPlayer(guildId);

  let result;

  try {
    result = await audioEngine.play(guildId, userId, state.current, {
      seekMs: startAt,
      preserveEarlyRetry,
    });
  } catch (error) {
    if (error?.code === "PLAYBACK_SUPERSEDED") {
      return snapshotPlayerState(loadPlayerState(guildId));
    }

    const live = loadPlayerState(guildId);
    if (trackIdentity(live.current) === identity) {
      live.playing = false;
      live.updatedAt = Date.now();
      savePlayerState(guildId, live);
      broadcastPlayer(guildId);
    }

    throw error;
  }

  const live = loadPlayerState(guildId);
  if (!live.current || trackIdentity(live.current) !== identity) {
    return snapshotPlayerState(live);
  }

  live.current = normalizeTrack(result.track);
  live.positionMs = Math.min(
    startAt,
    Number(live.current.durationMs || startAt) || startAt
  );
  live.playing = true;
  live.updatedAt = Date.now();
  savePlayerState(guildId, live);

  const player = broadcastPlayer(guildId);

  if (
    live.current &&
    live.baseKind === "radio" &&
    live.baseQueue.length <= RADIO_REFILL_AT
  ) {
    scheduleRadioAfterPlaybackStarts(guildId, live.current);
  }

  scheduleUpcomingPrefetch(guildId);
  return player;
}

async function toggleRealPause(guildId, userId) {
  const state = loadPlayerState(guildId);
  if (!state.current) return snapshotPlayerState(state);

  if (state.playing) {
    materializePosition(state);
    audioEngine.pause(guildId);
    state.playing = false;
    state.updatedAt = Date.now();
    savePlayerState(guildId, state);
    return broadcastPlayer(guildId);
  }

  // If the in-memory AudioPlayer survived and is paused, unpause instantly.
  if (audioEngine.resume(guildId)) {
    state.playing = true;
    state.updatedAt = Date.now();
    savePlayerState(guildId, state);
    return broadcastPlayer(guildId);
  }

  // After a bot restart there is no AudioPlayer to unpause. Rebuild it from
  // the rolling local cache at the saved position.
  await audioEngine.ensureVoice(guildId, userId);
  return startCurrentAudio(guildId, userId, {
    seekMs: state.positionMs,
    expectedIdentity: trackIdentity(state.current),
  });
}

async function seekCurrentReal(guildId, userId, requestedMs) {
  const state = loadPlayerState(guildId);
  if (!state.current) return snapshotPlayerState(state);

  const duration = Math.max(0, Number(state.current.durationMs || 0));
  let target = Math.max(0, Number(requestedMs || 0));

  if (duration > 0) {
    // Avoid asking FFmpeg to start beyond the actual end of the file.
    target = Math.min(target, Math.max(0, duration - 250));
  }

  const wasPlaying = Boolean(state.playing);

  if (!wasPlaying) {
    // Preserve Spotify-style paused seeking: move the logical playhead without
    // producing a tiny audible blip. The next Play rebuilds audio at target.
    audioEngine.stop(guildId);
    state.positionMs = target;
    state.playing = false;
    state.updatedAt = Date.now();
    savePlayerState(guildId, state);
    return broadcastPlayer(guildId);
  }

  await audioEngine.ensureVoice(guildId, userId);

  return startCurrentAudio(guildId, userId, {
    seekMs: target,
    expectedIdentity: trackIdentity(state.current),
  });
}

async function playQueuedItemReal(guildId, userId, kind, rawIndex) {
  const state = loadPlayerState(guildId);
  if (!state.current) return snapshotPlayerState(state);

  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("That queue item no longer exists.");
  }

  const queueKind = kind === "priority" ? "priority" : "base";
  let rawTrack = null;

  if (queueKind === "priority") {
    rawTrack = state.playNext[index] || null;
  } else {
    rawTrack = state.baseQueue[index] || null;
  }

  if (!rawTrack) {
    throw new Error("That queue item no longer exists.");
  }

  // Resolve metadata BEFORE mutating the visible queue.
  const prepared = await prepareTrackForGuild(guildId, rawTrack);

  materializePosition(state);
  if (state.current) pushHistory(state, state.current);

  if (queueKind === "priority") {
    // Clicking a later visible Play Next item means every queue entry between
    // the current song and the chosen one was intentionally skipped, exactly
    // like jumping ahead in the normal/base queue.
    state.playNext = state.playNext.slice(index + 1);
  } else {
    // Jumping to a base queue item means the entries above it were skipped.
    // Continue naturally from the songs that were below the chosen item.
    state.baseQueue = state.baseQueue.slice(index + 1);
  }

  state.current = normalizeTrack(prepared);
  state.positionMs = 0;
  state.playing = false;
  state.updatedAt = Date.now();
  state.radioFilling = false;

  if (
    queueKind === "base" &&
    state.baseKind === "playlist" &&
    !state.baseQueue.length &&
    !state.playNext.length
  ) {
    // If the user jumped to the last playlist song, radio should be ready to
    // take over afterwards rather than ending in silence.
    state.baseKind = "radio";
    invalidateRadio(guildId);
  } else if (state.baseKind === "radio") {
    invalidateRadio(guildId);
  }

  savePlayerState(guildId, state);
  broadcastPlayer(guildId);

  await audioEngine.ensureVoice(guildId, userId);

  return startCurrentAudio(guildId, userId, {
    seekMs: 0,
    expectedIdentity: trackIdentity(state.current),
  });
}

async function playNextReal(guildId, userId) {
  const before = loadPlayerState(guildId);
  const seed = before.current;

  audioEngine.stop(guildId);

  if (
    seed &&
    before.baseKind === "radio" &&
    !before.playNext.length &&
    !before.baseQueue.length
  ) {
    await waitForRadioAtTransition(guildId, seed);
  }

  let lastPlayer = snapshotPlayerState(before);

  // A bad queue entry should not kill a whole playlist/radio session. Skip
  // only provider/audio-preparation failures; voice/channel errors still stop
  // immediately so the user gets the real problem instead of silent skipping.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    lastPlayer = await advanceResolved(guildId);
    const live = loadPlayerState(guildId);

    if (!live.current) {
      return lastPlayer;
    }

    try {
      return await startCurrentAudio(guildId, userId, {
        seekMs: 0,
        expectedIdentity: trackIdentity(live.current),
      });
    } catch (error) {
      if (error?.code !== "AUDIO_PREPARE_FAILED") throw error;
      console.warn(`[audio skip] ${live.current.title}: ${error.message}`);
      audioEngine.stop(guildId);
    }
  }

  return lastPlayer;
}

async function playPreviousReal(guildId, userId) {
  audioEngine.stop(guildId);
  const player = applySimplePlayerAction(guildId, "previous", {});
  const state = loadPlayerState(guildId);

  if (!state.current) return player;

  return startCurrentAudio(guildId, userId, {
    seekMs: 0,
    expectedIdentity: trackIdentity(state.current),
  });
}

async function handleNaturalAudioEnd({ guildId, track }) {
  try {
    await withGuildActionLock(guildId, async () => {
      const state = loadPlayerState(guildId);
      if (!state.current || trackIdentity(state.current) !== trackIdentity(track)) {
        return;
      }

      state.positionMs = Number(state.current.durationMs || state.positionMs || 0);
      state.playing = false;
      state.updatedAt = Date.now();
      savePlayerState(guildId, state);

      await playNextReal(guildId, "");
    });
  } catch (error) {
    console.error(`[autoplay] ${error.message}`);
  }
}

async function handlePrematureAudioEnd({ guildId, track, positionMs }) {
  try {
    await withGuildActionLock(guildId, async () => {
      const state = loadPlayerState(guildId);
      if (!state.current || trackIdentity(state.current) !== trackIdentity(track)) {
        return;
      }

      state.positionMs = Math.max(0, Number(positionMs || 0));
      state.playing = false;
      state.updatedAt = Date.now();
      savePlayerState(guildId, state);
      broadcastPlayer(guildId);

      try {
        await startCurrentAudio(guildId, "", {
          seekMs: state.positionMs,
          expectedIdentity: trackIdentity(state.current),
          preserveEarlyRetry: true,
        });
      } catch (retryError) {
        console.warn(`[audio retry] ${retryError.message}`);
        await playNextReal(guildId, "");
      }
    });
  } catch (error) {
    console.error(`[audio premature end] ${error.message}`);
  }
}

const audioEngine = new DiscordAudioEngine({
  client,
  onNaturalEnd: handleNaturalAudioEnd,
  onPrematureEnd: handlePrematureAudioEnd,
  onError: ({ guildId, error, track }) => {
    console.error(
      `[voice ${guildId}] ${track?.title || "audio"}: ${error?.message || error}`
    );
  },
  onStatus: ({ guildId, status }) => {
    broadcastGuild(guildId, {
      type: "voice_status",
      voice: status,
    });
  },
});

function launcherPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x15161a)
    .setTitle("プレイヤー")
    .setDescription(
      "Your server's shared music player.\n\n" +
        "**Search • Libraries • Queue • Player**"
    )
    .setFooter({ text: "Open the player to start listening" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("player:open-activity")
      .setLabel("Open Player")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

client.once(Events.ClientReady, (ready) => {
  console.log(`[discord] Online as ${ready.user.tag}`);
  console.log("[discord] Phase 5 hybrid fast-start playback enabled.");
  console.log("[discord] !spawn recreates the Activity launcher at the newest channel position.");

  warmSearchEngine()
    .then((ok) => {
      if (ok) console.log("[resolver] YouTube Music search session warmed.");
    })
    .catch(() => {});
});

client.on(Events.GuildMemberAdd, (member) => {
  memberListCache.delete(member.guild.id);
});

client.on(Events.GuildMemberRemove, (member) => {
  memberListCache.delete(member.guild.id);
});

client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
  memberListCache.delete(newMember.guild.id);
});

client.on(Events.MessageCreate, async (message) => {
  if (
    message.author.bot ||
    !message.guild ||
    message.content.trim().toLowerCase() !== `${PREFIX}spawn`.toLowerCase()
  ) {
    return;
  }

  const existing = db
    .prepare(`
      SELECT channel_id, message_id
      FROM launcher_messages
      WHERE guild_id = ?
    `)
    .get(message.guild.id);

  if (existing) {
    try {
      const channel = await client.channels.fetch(existing.channel_id);
      if (channel?.isTextBased()) {
        const oldMessage = await channel.messages.fetch(existing.message_id);
        await oldMessage.delete().catch(() => {});
      }
    } catch {}
  }

  const launcher = await message.channel.send(launcherPayload());

  db.prepare(`
    INSERT INTO launcher_messages(guild_id, channel_id, message_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      updated_at = excluded.updated_at
  `).run(
    message.guild.id,
    launcher.channel.id,
    launcher.id,
    Date.now()
  );

  try {
    await message.delete();
  } catch {}
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isButton() ||
    interaction.customId !== "player:open-activity"
  ) {
    return;
  }

  try {
    await interaction.launchActivity();
  } catch (error) {
    console.error("[activity launch]", error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "The Activity could not be launched from this client/configuration.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
});

// ============================================================
// OAUTH SESSION LAYER
// ============================================================

const sessions = new Map();
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

setInterval(pruneSessions, 30 * 60 * 1000).unref();

function publicOauthUser(user) {
  return {
    id: String(user.id),
    username: compactText(user.username, 80),
    globalName: compactText(user.global_name || user.username, 80),
    avatar: user.avatar || null,
  };
}

function authHeaderToken(req) {
  const value = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] || "";
}

function requireSession(req, res, next) {
  pruneSessions();

  const token = authHeaderToken(req);
  const session = sessions.get(token);

  if (!session) {
    res.status(401).json({ error: "SESSION_EXPIRED" });
    return;
  }

  req.playerSession = session;
  req.playerSessionToken = token;
  next();
}

function assertSessionGuild(session, guildId) {
  if (!/^\d{5,30}$/.test(guildId || "")) {
    const error = new Error("Invalid guild ID.");
    error.statusCode = 400;
    throw error;
  }

  if (!session.guildIds.has(guildId)) {
    const error = new Error("Your Discord account is not in this server.");
    error.statusCode = 403;
    throw error;
  }
}

// ============================================================
// EXPRESS API
// ============================================================

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    phase: "phase-5-app-first",
    resolver: resolverStatus(),
    audio: audioRuntimeStatus(),
    discordReady: client.isReady(),
    database: "sqlite",
    websocket: true,
  });
});

app.post(
  "/api/token",
  asyncRoute(async (req, res) => {
    const code = compactText(req.body?.code, 1000);

    if (!code) {
      res.status(400).json({ error: "Missing OAuth code." });
      return;
    }

    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });

    const tokenJson = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenJson.access_token) {
      console.error("[oauth token]", tokenJson);
      res.status(400).json({
        error: "Discord OAuth token exchange failed.",
      });
      return;
    }

    const oauthHeaders = {
      Authorization: `Bearer ${tokenJson.access_token}`,
    };

    const [userResponse, guildsResponse] = await Promise.all([
      fetch("https://discord.com/api/users/@me", { headers: oauthHeaders }),
      fetch("https://discord.com/api/users/@me/guilds", { headers: oauthHeaders }),
    ]);

    if (!userResponse.ok || !guildsResponse.ok) {
      res.status(400).json({
        error: "Discord OAuth identity lookup failed.",
      });
      return;
    }

    const user = await userResponse.json();
    const guilds = await guildsResponse.json();

    const sessionToken = newSessionToken();
    const expiresInMs = Math.max(60_000, Number(tokenJson.expires_in || 3600) * 1000);

    sessions.set(sessionToken, {
      user: publicOauthUser(user),
      guildIds: new Set((guilds || []).map((guild) => String(guild.id))),
      expiresAt: Date.now() + Math.min(expiresInMs, MAX_SESSION_MS),
    });

    res.json({
      access_token: tokenJson.access_token,
      session_token: sessionToken,
      user: publicOauthUser(user),
    });
  })
);

app.get(
  "/api/bootstrap",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.query.guildId || "");
    const instanceId = compactText(req.query.instanceId, 120);
    const session = req.playerSession;

    assertSessionGuild(session, guildId);

    const guild = await getGuildOrThrow(guildId);
    const members = await getDecoratedGuildMembers(guildId, session.user.id);

    if (!members.some((member) => member.id === session.user.id)) {
      res.status(403).json({
        error: "Your account is not present in the bot's member list for this server.",
      });
      return;
    }

    const ownLibrary = getLibrary(guildId, session.user.id);
    const livePlayer = loadPlayerState(guildId);

    if (
      livePlayer.current &&
      livePlayer.baseKind === "radio" &&
      livePlayer.baseQueue.length <= RADIO_REFILL_AT
    ) {
      scheduleRadioFill(guildId, livePlayer.current);
    }

    res.json({
      me: session.user,
      guild: {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL({ extension: "png", size: 128 }) || "",
      },
      instanceId,
      members,
      ownLibrary,
      player: snapshotPlayerState(livePlayer),
      voice: audioEngine.getStatus(guildId),
    });
  })
);

app.get(
  "/api/library/:userId",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.query.guildId || "");
    const userId = String(req.params.userId || "");
    const session = req.playerSession;

    assertSessionGuild(session, guildId);
    await assertGuildMember(guildId, userId);

    res.json({
      library: getLibrary(guildId, userId),
    });
  })
);

app.post(
  "/api/library/likes/toggle",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.body?.guildId || "");
    const session = req.playerSession;
    assertSessionGuild(session, guildId);

    const result = toggleLike(guildId, session.user.id, req.body?.track);
    const counts = getLibraryCounts(guildId, session.user.id);

    broadcastGuild(guildId, {
      type: "library_changed",
      userId: session.user.id,
      counts,
    });

    res.json({
      liked: result.liked,
      library: result.library,
      counts,
    });
  })
);

app.post(
  "/api/library/playlists",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.body?.guildId || "");
    const session = req.playerSession;
    assertSessionGuild(session, guildId);

    let playlistId;

    runTransaction(() => {
      playlistId = createPlaylist(guildId, session.user.id, req.body?.name);

      if (req.body?.track?.title) {
        addTrackToPlaylist(
          guildId,
          session.user.id,
          playlistId,
          req.body.track
        );
      }
    });

    const library = getLibrary(guildId, session.user.id);
    const counts = getLibraryCounts(guildId, session.user.id);

    broadcastGuild(guildId, {
      type: "library_changed",
      userId: session.user.id,
      counts,
    });

    res.json({
      playlistId,
      library,
      counts,
    });
  })
);

app.delete(
  "/api/library/playlists/:playlistId",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.query.guildId || "");
    const playlistId = Number(req.params.playlistId);
    const session = req.playerSession;

    assertSessionGuild(session, guildId);
    assertOwnedPlaylist(guildId, session.user.id, playlistId);

    db.prepare(`DELETE FROM playlists WHERE id = ?`).run(playlistId);

    const library = getLibrary(guildId, session.user.id);
    const counts = getLibraryCounts(guildId, session.user.id);

    broadcastGuild(guildId, {
      type: "library_changed",
      userId: session.user.id,
      counts,
    });

    res.json({ library, counts });
  })
);

app.post(
  "/api/library/playlists/:playlistId/tracks",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.body?.guildId || "");
    const playlistId = Number(req.params.playlistId);
    const session = req.playerSession;

    assertSessionGuild(session, guildId);

    const library = addTrackToPlaylist(
      guildId,
      session.user.id,
      playlistId,
      req.body?.track
    );

    const counts = getLibraryCounts(guildId, session.user.id);

    broadcastGuild(guildId, {
      type: "library_changed",
      userId: session.user.id,
      counts,
    });

    res.json({ library, counts });
  })
);

app.delete(
  "/api/library/playlists/:playlistId/tracks/:trackKey",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.query.guildId || "");
    const playlistId = Number(req.params.playlistId);
    const trackKey = compactText(req.params.trackKey, 64);
    const session = req.playerSession;

    assertSessionGuild(session, guildId);

    const library = removeTrackFromPlaylist(
      guildId,
      session.user.id,
      playlistId,
      trackKey
    );

    const counts = getLibraryCounts(guildId, session.user.id);

    broadcastGuild(guildId, {
      type: "library_changed",
      userId: session.user.id,
      counts,
    });

    res.json({ library, counts });
  })
);

app.post(
  "/api/music/search",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.body?.guildId || "");
    const query = compactText(req.body?.query, 1200);
    const mode = musicMode(req.body?.mode);
    const session = req.playerSession;

    assertSessionGuild(session, guildId);

    if (!query) {
      res.json({
        query: "",
        mode,
        kind: "search",
        title: "",
        source: "",
        sourceUrl: "",
        total: 0,
        results: [],
      });
      return;
    }

    const startedAt = Date.now();
    const result = await searchMusic(query, mode, 6);

    console.log(
      `[search] "${query.slice(0, 60)}" mode=${mode} results=${result.results.length} ${Date.now() - startedAt}ms`
    );

    res.json({
      query,
      mode,
      ...result,
    });
  })
);

app.post(
  "/api/music/search-play",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.body?.guildId || "");
    const query = compactText(req.body?.query, 1200);
    const mode = musicMode(req.body?.mode);
    const session = req.playerSession;

    assertSessionGuild(session, guildId);
    if (!query) throw new Error("Search is empty.");

    const startedAt = Date.now();

    // Explicit user searches always outrank background queue preparation.
    // This prevents a gentle prefetch from making the second/third search feel
    // like the resolver "gave up".
    audioEngine.cancelPrefetches();

    // Latest Search/Play wins even when two members search nearly together.
    const intent = nextIntentGeneration(guildId);

    // Voice connection and music lookup are independent, so do them together
    // instead of making the user wait for one and then the other.
    const [resolved] = await Promise.all([
      resolveInput(query, mode),
      audioEngine.ensureVoice(guildId, session.user.id),
    ]);

    const resolvedAt = Date.now();

    let player = await withGuildActionLock(guildId, async () => {
      if (currentIntentGeneration(guildId) !== intent) return null;

      if (resolved.kind === "playlist") {
        return replaceWithCollection(guildId, resolved.tracks);
      }

      const first = resolved.tracks?.[0];
      if (!first) throw new Error("No usable track was resolved.");
      return replaceWithSingle(guildId, first);
    });

    if (!player) {
      res.json({
        superseded: true,
        player: snapshotPlayerState(loadPlayerState(guildId)),
      });
      return;
    }

    const identity = currentTrackIdentity(guildId);

    try {
      player = await startCurrentAudio(guildId, session.user.id, {
        seekMs: 0,
        expectedIdentity: identity,
      });
    } catch (error) {
      if (
        error?.code === "AUDIO_PREPARE_FAILED" &&
        resolved.kind === "playlist"
      ) {
        console.warn(`[playlist first-track skip] ${error.message}`);
        player = await withGuildActionLock(guildId, () =>
          playNextReal(guildId, session.user.id)
        );
      } else if (
        error?.code === "AUDIO_PREPARE_FAILED" &&
        resolved.kind === "single" &&
        Array.isArray(resolved.alternates) &&
        resolved.alternates.length
      ) {
        let recovered = false;
        let lastError = error;

        for (const alternate of resolved.alternates.slice(0, 3)) {
          try {
            console.warn(
              `[search fallback] ${resolved.tracks?.[0]?.title || query} -> ${alternate.title}`
            );

            await withGuildActionLock(guildId, () =>
              replaceWithSingle(guildId, alternate)
            );

            player = await startCurrentAudio(guildId, session.user.id, {
              seekMs: 0,
              expectedIdentity: currentTrackIdentity(guildId),
            });

            recovered = true;
            break;
          } catch (alternateError) {
            lastError = alternateError;
          }
        }

        if (!recovered) throw lastError;
      } else {
        throw error;
      }
    }

    const superseded = currentIntentGeneration(guildId) !== intent;

    console.log(
      `[timing] "${query.slice(0, 60)}" lookup=${resolvedAt - startedAt}ms total=${Date.now() - startedAt}ms`
    );

    res.json({
      superseded,
      result: {
        kind: resolved.kind,
        title: resolved.title,
        source: resolved.source,
        count: resolved.tracks.length,
      },
      player,
    });
  })
);

app.post(
  "/api/player/action",
  requireSession,
  asyncRoute(async (req, res) => {
    const guildId = String(req.body?.guildId || "");
    const action = compactText(req.body?.action, 40);
    const session = req.playerSession;
    assertSessionGuild(session, guildId);

    let player;

    if (action === "play_single") {
      audioEngine.cancelPrefetches();
      await audioEngine.ensureVoice(guildId, session.user.id);
      nextIntentGeneration(guildId);

      player = await withGuildActionLock(guildId, async () => {
        await replaceWithSingle(guildId, req.body?.track);
        const identity = currentTrackIdentity(guildId);
        return startCurrentAudio(guildId, session.user.id, {
          seekMs: 0,
          expectedIdentity: identity,
        });
      });
    } else if (action === "play_next") {
      const hadCurrent = Boolean(loadPlayerState(guildId).current);

      if (!hadCurrent) {
        await audioEngine.ensureVoice(guildId, session.user.id);
      }

      player = await withGuildActionLock(guildId, async () => {
        const result = await enqueuePlayNext(guildId, req.body?.track);
        const live = loadPlayerState(guildId);

        if (!hadCurrent && live.current) {
          return startCurrentAudio(guildId, session.user.id, {
            seekMs: 0,
            expectedIdentity: trackIdentity(live.current),
          });
        }

        scheduleUpcomingPrefetch(guildId);
        return result;
      });
    } else if (action === "play_collection") {
      audioEngine.cancelPrefetches();
      await audioEngine.ensureVoice(guildId, session.user.id);
      nextIntentGeneration(guildId);

      player = await withGuildActionLock(guildId, async () => {
        await replaceWithCollection(guildId, req.body?.tracks);
        const identity = currentTrackIdentity(guildId);

        try {
          return await startCurrentAudio(guildId, session.user.id, {
            seekMs: 0,
            expectedIdentity: identity,
          });
        } catch (error) {
          if (error?.code === "AUDIO_PREPARE_FAILED") {
            console.warn(`[saved playlist first-track skip] ${error.message}`);
            return playNextReal(guildId, session.user.id);
          }
          throw error;
        }
      });
    } else if (action === "seek") {
      player = await withGuildActionLock(guildId, () =>
        seekCurrentReal(
          guildId,
          session.user.id,
          req.body?.positionMs
        )
      );
    } else if (action === "play_queue_item") {
      audioEngine.cancelPrefetches();
      player = await withGuildActionLock(guildId, () =>
        playQueuedItemReal(
          guildId,
          session.user.id,
          req.body?.kind,
          req.body?.index
        )
      );
    } else if (action === "toggle_pause") {
      player = await withGuildActionLock(guildId, () =>
        toggleRealPause(guildId, session.user.id)
      );
    } else if (action === "next") {
      if (loadPlayerState(guildId).current) {
        await audioEngine.ensureVoice(guildId, session.user.id);
      }
      player = await withGuildActionLock(guildId, () =>
        playNextReal(guildId, session.user.id)
      );
    } else if (action === "previous") {
      const state = loadPlayerState(guildId);
      if (state.history.length) {
        await audioEngine.ensureVoice(guildId, session.user.id);
      }
      player = await withGuildActionLock(guildId, () =>
        playPreviousReal(guildId, session.user.id)
      );

      const live = loadPlayerState(guildId);
      if (
        live.current &&
        live.baseKind === "radio" &&
        live.baseQueue.length <= RADIO_REFILL_AT
      ) {
        scheduleRadioFill(guildId, live.current);
      }
    } else if (action === "clear") {
      audioEngine.stop(guildId);
      player = await withGuildActionLock(guildId, () =>
        Promise.resolve(applySimplePlayerAction(guildId, action, req.body || {}))
      );
    } else {
      player = await withGuildActionLock(guildId, () =>
        Promise.resolve(applySimplePlayerAction(guildId, action, req.body || {}))
      );

      const live = loadPlayerState(guildId);
      if (
        live.current &&
        live.baseKind === "radio" &&
        live.baseQueue.length <= RADIO_REFILL_AT &&
        action === "remove_queue"
      ) {
        scheduleRadioFill(guildId, live.current);
      }
    }

    res.json({ player });
  })
);

// Activity iframes can be picky about loading third-party artwork directly.
// Proxy only known YouTube/Spotify image CDNs through our own Activity origin.
const ARTWORK_HOST_SUFFIXES = [
  ".ytimg.com",
  ".googleusercontent.com",
  ".scdn.co",
  ".spotifycdn.com",
];

function allowedArtworkUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!ARTWORK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

// Artwork is requested repeatedly by the center cover, queue, libraries, and
// every connected Activity client. Browser caching helps after the first load,
// but without a server cache each phone/desktop still made our PC refetch the
// same image from YouTube/Spotify. Keep a small LRU and coalesce simultaneous
// misses so artwork is cheap after the first request.
const ARTWORK_CACHE_MAX_ENTRIES = 120;
const ARTWORK_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const ARTWORK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const artworkCache = new Map();
const artworkInflight = new Map();
let artworkCacheBytes = 0;

function cachedArtwork(key) {
  const cached = artworkCache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    artworkCache.delete(key);
    artworkCacheBytes = Math.max(0, artworkCacheBytes - cached.body.length);
    return null;
  }

  // Refresh LRU position.
  artworkCache.delete(key);
  artworkCache.set(key, cached);
  return cached;
}

function rememberArtwork(key, value) {
  if (!value?.body?.length || value.body.length > 4 * 1024 * 1024) return;

  const previous = artworkCache.get(key);
  if (previous) {
    artworkCacheBytes = Math.max(0, artworkCacheBytes - previous.body.length);
    artworkCache.delete(key);
  }

  const entry = {
    ...value,
    expiresAt: Date.now() + ARTWORK_CACHE_TTL_MS,
  };
  artworkCache.set(key, entry);
  artworkCacheBytes += entry.body.length;

  while (
    artworkCache.size > ARTWORK_CACHE_MAX_ENTRIES ||
    artworkCacheBytes > ARTWORK_CACHE_MAX_BYTES
  ) {
    const oldestKey = artworkCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = artworkCache.get(oldestKey);
    artworkCache.delete(oldestKey);
    artworkCacheBytes = Math.max(0, artworkCacheBytes - Number(oldest?.body?.length || 0));
  }
}

async function fetchArtwork(url) {
  const key = url.href;
  const cached = cachedArtwork(key);
  if (cached) return cached;

  if (artworkInflight.has(key)) return artworkInflight.get(key);

  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const upstream = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "player-activity-phase5-artwork/1.0",
        },
      });

      if (!upstream.ok) {
        const error = new Error("Artwork source did not respond successfully.");
        error.statusCode = 502;
        throw error;
      }

      const contentType = String(upstream.headers.get("content-type") || "");
      if (!contentType.toLowerCase().startsWith("image/")) {
        const error = new Error("Artwork source did not return an image.");
        error.statusCode = 415;
        throw error;
      }

      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 8 * 1024 * 1024) {
        const error = new Error("Artwork image is too large.");
        error.statusCode = 413;
        throw error;
      }

      const value = { body, contentType };
      rememberArtwork(key, value);
      return value;
    } finally {
      clearTimeout(timer);
    }
  })();

  artworkInflight.set(key, request);
  try {
    return await request;
  } finally {
    if (artworkInflight.get(key) === request) artworkInflight.delete(key);
  }
}

app.get(
  "/api/artwork",
  asyncRoute(async (req, res) => {
    const url = allowedArtworkUrl(req.query.url);
    if (!url) {
      res.status(400).end();
      return;
    }

    const artwork = await fetchArtwork(url);
    res.setHeader("Content-Type", artwork.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.send(artwork.body);
  })
);

// ============================================================
// STATIC FRONTEND + WEBSOCKET
// ============================================================

if (fs.existsSync(DIST_DIR)) {
  app.use(
    express.static(DIST_DIR, {
      etag: true,
      maxAge: "1h",
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    })
  );

  // Express 5 / path-to-regexp does not accept app.get("*").
  app.use((_req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  const status = Number(error?.statusCode || 500);

  if (status >= 500) {
    console.error("[api]", error);
  }

  res.status(status).json({
    error: error?.message || "Unexpected server error.",
  });
});

const httpServer = http.createServer(app);

// Keep local cloudflared -> Node connections warm. Node's short default
// keep-alive causes needless connection churn during an Activity session,
// especially when desktop + mobile are testing the same Quick Tunnel.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;
httpServer.requestTimeout = 120_000;
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
});

function socketSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

function broadcastGuild(guildId, payload) {
  for (const ws of wss.clients) {
    if (ws.guildId === guildId) {
      socketSend(ws, payload);
    }
  }
}

wss.on("connection", async (ws, request) => {
  try {
    const url = new URL(request.url || "/ws", "http://localhost");
    const sessionToken = String(url.searchParams.get("session") || "");
    const guildId = String(url.searchParams.get("guildId") || "");
    const session = sessions.get(sessionToken);

    if (!session || session.expiresAt <= Date.now()) {
      ws.close(4401, "Session expired");
      return;
    }

    assertSessionGuild(session, guildId);
    await getGuildOrThrow(guildId);

    ws.guildId = guildId;
    ws.userId = session.user.id;
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    socketSend(ws, {
      type: "hello",
      player: snapshotPlayerState(loadPlayerState(guildId)),
      voice: audioEngine.getStatus(guildId),
    });
  } catch (error) {
    ws.close(4403, compactText(error?.message || "Forbidden", 120));
  }
});

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30_000);
pingTimer.unref();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[web] Backend listening on http://127.0.0.1:${PORT}`);
  console.log(`[db] SQLite: ${DB_PATH}`);
  console.log("[ws] Shared guild state: /ws");
  const audio = audioRuntimeStatus();
  console.log(`[audio] FFmpeg: ${audio.ffmpegReady ? "ready" : "MISSING"}`);
  console.log(
    `[audio] Rolling cache: ${audio.cacheDir} ` +
    `(max ${audio.cacheLimitFiles} files / ${audio.cacheLimitMb} MB)`
  );
  const resolver = resolverStatus();
  console.log(`[resolver] yt-dlp: ${resolver.ytDlpReady ? "ready" : "MISSING"}`);
  console.log(`[resolver] YouTube cookies: ${resolver.cookiesPresent ? "present" : "not supplied"}`);

  if (fs.existsSync(DIST_DIR)) {
    console.log("[web] Activity frontend: production build served by backend");
  } else {
    console.log("[web] WARNING: dist/ is missing; run npm run build first.");
  }
});

try {
  await client.login(TOKEN);
} catch (error) {
  console.error("[fatal] Discord login failed:", error);
  console.error(
    "[hint] Phase 4 requires Developer Portal -> Bot -> Server Members Intent ON."
  );
  process.exit(1);
}
