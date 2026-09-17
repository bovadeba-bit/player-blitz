import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(__dirname, "runtime");

function assetName() {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  }
  if (process.platform === "darwin") return "yt-dlp_macos";
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
}

function destinationName() {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "player-activity-phase5-runtime" },
  });

  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const temp = `${destination}.part`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
}

fs.mkdirSync(runtimeDir, { recursive: true });
const destination = path.join(runtimeDir, destinationName());

function runtimeWorks(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size <= 1_000_000) return false;
  try {
    const result = spawnSync(file, ["--version"], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    });
    return result.status === 0 && Boolean(String(result.stdout || "").trim());
  } catch {
    return false;
  }
}

if (runtimeWorks(destination)) {
  console.log(`[runtime] yt-dlp ready: ${destination}`);
} else {
  try {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
  } catch {}

  const asset = assetName();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`[runtime] Downloading standalone yt-dlp (${asset})...`);
  await download(url, destination);

  if (!runtimeWorks(destination)) {
    throw new Error(`Downloaded yt-dlp could not execute on ${process.platform}/${process.arch}.`);
  }

  console.log(`[runtime] yt-dlp downloaded and verified: ${destination}`);
}
