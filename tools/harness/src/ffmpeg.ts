/**
 * ffmpeg for clips (DOD §3: 4–6 s WebM per hero animation). The harness steps the scenario's
 * clock frame by frame, screenshots each frame as JPEG and encodes the sequence to VP8 WebM, so a
 * clip shows the real motion at a steady frame rate whatever the machine's render speed (a
 * real-time recording of SwiftShader would show its stalls, not the game's motion).
 *
 * The binary is found in this order: `SG_FFMPEG`, the ffmpeg Playwright installs next to its
 * browsers (`npx playwright install ffmpeg`), then `ffmpeg` on the PATH.
 *
 * @module
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Candidate directories of Playwright's browser cache. */
export function playwrightCacheDirs(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const dirs: string[] = [];
  const custom = env["PLAYWRIGHT_BROWSERS_PATH"];
  if (custom !== undefined && custom !== "" && custom !== "0") dirs.push(custom);
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local !== undefined) dirs.push(join(local, "ms-playwright"));
  } else if (platform === "darwin") dirs.push(join(homedir(), "Library", "Caches", "ms-playwright"));
  else dirs.push(join(env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "ms-playwright"));
  return dirs;
}

const BINARIES = ["ffmpeg-win64.exe", "ffmpeg-linux", "ffmpeg-mac", "ffmpeg.exe", "ffmpeg"];

/** Resolves an ffmpeg executable, or null when none is available. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const explicit = env["SG_FFMPEG"];
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
  for (const dir of playwrightCacheDirs(env, platform)) {
    if (!existsSync(dir)) continue;
    const ffDirs = readdirSync(dir).filter((d) => d.startsWith("ffmpeg")).sort().reverse();
    for (const d of ffDirs)
      for (const bin of BINARIES) {
        const p = join(dir, d, bin);
        if (existsSync(p)) return p;
      }
  }
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch {
    return null;
  }
}

/** Parses "Duration: 00:00:05.04" from ffmpeg's stderr, in seconds (null when absent). */
export function parseDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (m === null) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Runs ffmpeg and returns its stderr (ffmpeg logs there); throws with the log on failure. */
function run(ffmpeg: string, args: string[]): string {
  try {
    execFileSync(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    return "";
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    // `ffmpeg -i file` with no output exits 1 by design; callers that probe accept that.
    if (e.stderr !== undefined && e.status === 1 && args[args.length - 2] === "-i") return e.stderr;
    throw new Error(`ffmpeg ${args.join(" ")} failed: ${e.stderr ?? String(err)}`);
  }
}

/** A WebM's duration in seconds (null when ffmpeg reports none). */
export function probeDuration(ffmpeg: string, file: string): number | null {
  return parseDuration(run(ffmpeg, ["-hide_banner", "-i", file]));
}

/**
 * Encodes JPEG frames (in order) at `fps` into a VP8 WebM. The frames go through a temporary
 * concatenated-JPEG file (`image2pipe` demuxer): Playwright's ffmpeg build has no pipe protocol.
 */
export function encodeJpegFrames(ffmpeg: string, frames: readonly Buffer[], fps: number, output: string): void {
  if (frames.length === 0) throw new Error("encodeJpegFrames: no frames");
  const stream = `${output}.frames.mjpeg`;
  writeFileSync(stream, Buffer.concat(frames));
  const res = spawnSync(
    ffmpeg,
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-c:v",
      "mjpeg",
      "-i",
      stream,
      "-an",
      "-c:v",
      "libvpx",
      "-b:v",
      "4M",
      "-deadline",
      "good",
      "-cpu-used",
      "2",
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
  );
  rmSync(stream, { force: true });
  if (res.status !== 0)
    throw new Error(`ffmpeg encode failed (${res.status ?? "?"}): ${res.stderr?.toString() ?? String(res.error)}`);
}
