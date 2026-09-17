import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const root = process.cwd();
const mode = String(process.argv[2] || "deps").toLowerCase();
const failures = [];
const notes = [];

function ok(label, detail = "") {
  console.log(`[OK] ${label}${detail ? `: ${detail}` : ""}`);
}

function fail(label, error) {
  const message = error instanceof Error ? error.message : String(error || "failed");
  failures.push(`${label}: ${message}`);
  console.error(`[FAIL] ${label}: ${message}`);
}

function versionTuple(value) {
  return String(value || "")
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number(part) || 0);
}

function versionAtLeast(actual, minimum) {
  const a = versionTuple(actual);
  const b = versionTuple(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

if (!versionAtLeast(process.version, "22.13.0")) {
  fail("Node.js version", `found ${process.version}; プレイヤー requires Node.js 22.13+`);
} else {
  ok("Node.js version", `${process.version} (${process.platform}/${process.arch})`);
}

async function checkDependencies() {
  const imports = [
    ["Discord Embedded App SDK", "@discord/embedded-app-sdk"],
    ["discord.js", "discord.js"],
    ["WebSocket", "ws"],
    ["Spotify metadata", "spotify-url-info"],
    ["YouTube.js", "youtubei.js"],
    ["Discord voice/native audio binding", "@discordjs/voice"],
    ["Rollup native binding", "rollup"],
  ];

  for (const [label, specifier] of imports) {
    try {
      await import(specifier);
      ok(label);
    } catch (error) {
      fail(label, error);
    }
  }

  try {
    const esbuild = await import("esbuild");
    await esbuild.transform("const phase5 = true;", { loader: "js" });
    ok("esbuild native binary");
  } catch (error) {
    fail("esbuild native binary", error);
  }

  try {
    const ffmpegPath = require("ffmpeg-static");
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      throw new Error(`ffmpeg-static returned a missing path: ${ffmpegPath || "<empty>"}`);
    }
    ok("FFmpeg binary", ffmpegPath);
  } catch (error) {
    fail("FFmpeg binary", error);
  }
}

function checkEnvironment() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) {
    fail(".env", "missing; copy your working Phase 4.4 .env into this folder");
    return;
  }

  const text = fs.readFileSync(envPath, "utf8");
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (match) names.add(match[1]);
  }

  for (const required of ["DISCORD_TOKEN", "VITE_DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"]) {
    if (!names.has(required)) fail(`.env ${required}`, "missing variable");
    else ok(`.env ${required}`, "present (value hidden)");
  }
}

function checkDatabase() {
  const dbPath = path.join(root, "data", "player.sqlite");
  if (!fs.existsSync(dbPath)) {
    notes.push("No existing data/player.sqlite was supplied; a new database will be created on first start.");
    console.log("[INFO] Database: no existing player.sqlite (fresh install is okay)");
    return;
  }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA integrity_check").get();
    const verdict = String(Object.values(row || {})[0] || "");
    db.close();
    if (verdict.toLowerCase() !== "ok") throw new Error(verdict || "integrity check failed");
    ok("SQLite integrity", "ok");
  } catch (error) {
    fail("SQLite integrity", error);
  }
}

function checkRuntime() {
  const ytDlp = path.join(root, "runtime", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (!fs.existsSync(ytDlp)) fail("yt-dlp runtime", "missing; run node ensure_runtime.js");
  else ok("yt-dlp runtime", ytDlp);
}

function checkBuild() {
  const index = path.join(root, "dist", "index.html");
  const assets = path.join(root, "dist", "assets");
  if (!fs.existsSync(index)) fail("Vite production build", "dist/index.html is missing");
  else ok("Vite production build", "dist/index.html present");

  try {
    const assetFiles = fs.existsSync(assets)
      ? fs.readdirSync(assets).filter((name) => /\.(?:js|css)$/i.test(name))
      : [];
    if (!assetFiles.some((name) => name.endsWith(".js"))) {
      throw new Error("no JavaScript bundle found in dist/assets");
    }
    if (!assetFiles.some((name) => name.endsWith(".css"))) {
      throw new Error("no CSS bundle found in dist/assets");
    }
    ok("Built frontend assets", `${assetFiles.length} JS/CSS files`);
  } catch (error) {
    fail("Built frontend assets", error);
  }
}

if (mode === "deps" || mode === "post" || mode === "all") {
  await checkDependencies();
}
if (mode === "post" || mode === "all") {
  checkEnvironment();
  checkDatabase();
  checkRuntime();
  checkBuild();
}

if (notes.length) {
  console.log("\nNotes:");
  for (const note of notes) console.log(`- ${note}`);
}

if (failures.length) {
  console.error(`\nプレイヤー verification FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"}).`);
  process.exit(1);
}

console.log(`\nプレイヤー verification PASSED (${mode}).`);
