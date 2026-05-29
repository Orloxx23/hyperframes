/**
 * Video analysis helper for the `analyze_video` MCP tool.
 *
 * Extracts a small set of representative keyframes (downscaled JPEG) plus
 * structural metadata so a multimodal Claude turn can reason about a video
 * the user uploaded into the project. Used to author skills that describe
 * the video's style and animation patterns.
 *
 * Sampling strategy is uniform across the video duration — predictable
 * frame count, predictable token cost. Scene-change detection was considered
 * but yields highly variable counts (2 → 100+) which breaks the token
 * budget contract with the model.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFFmpeg, findFFprobe, getFFmpegInstallHint } from "../browser/ffmpeg.js";

export interface VideoMetadata {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
}

export interface Keyframe {
  /** JPEG-encoded buffer, downscaled per `extractKeyframes` options. */
  buffer: Buffer;
  /** Source timestamp in milliseconds. */
  timestampMs: number;
}

export interface ExtractKeyframesOptions {
  /**
   * Target number of frames. Clamped to [1, 20]. When omitted we pick a
   * sensible default based on duration:
   *   ≤ 10s  → 6 frames
   *   ≤ 60s → 10 frames
   *   > 60s → 14 frames
   */
  maxFrames?: number;
  /** Longest output side in pixels (aspect ratio preserved). Default 1024. */
  maxLongSide?: number;
  /**
   * ffmpeg JPEG quality (`-q:v`). 1 = best, 31 = worst. Default 4 — good
   * enough for visual analysis without blowing the token budget.
   */
  jpegQuality?: number;
}

export class FFmpegMissingError extends Error {
  constructor(binary: "ffmpeg" | "ffprobe") {
    super(`${binary} is not installed or not on PATH. Install it: ${getFFmpegInstallHint()}`);
    this.name = "FFmpegMissingError";
  }
}

interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
}

interface FFprobeOutput {
  streams?: FFprobeStream[];
  format?: { duration?: string };
}

function parseFraction(value: string | undefined): number | null {
  if (!value) return null;
  const [a, b] = value.split("/");
  if (b === undefined) {
    const n = Number(a);
    return Number.isFinite(n) ? n : null;
  }
  const num = Number(a);
  const den = Number(b);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

function runCommand(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      rejectResult(new Error(`${binary} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs ?? 60_000);

    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectResult(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolveResult({ stdout: Buffer.concat(stdoutChunks), stderr });
      } else {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        rejectResult(new Error(`${binary} exited ${code}: ${tail || "(no stderr)"}`));
      }
    });
  });
}

export async function extractVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  if (!statSync(videoPath).isFile()) {
    throw new Error(`not a file: ${videoPath}`);
  }
  const ffprobe = findFFprobe();
  if (!ffprobe) throw new FFmpegMissingError("ffprobe");

  const { stdout } = await runCommand(
    ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath],
    { timeoutMs: 15_000 },
  );

  let parsed: FFprobeOutput;
  try {
    parsed = JSON.parse(stdout.toString("utf-8")) as FFprobeOutput;
  } catch (e) {
    throw new Error(`ffprobe output was not valid JSON: ${e instanceof Error ? e.message : e}`);
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  if (!videoStream) throw new Error("no video stream found");

  const durationSecRaw = videoStream.duration ?? parsed.format?.duration;
  const durationSec = durationSecRaw ? Number(durationSecRaw) : NaN;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("could not determine video duration");
  }

  const fps =
    parseFraction(videoStream.avg_frame_rate) ?? parseFraction(videoStream.r_frame_rate) ?? 30;

  return {
    durationMs: Math.round(durationSec * 1000),
    fps: Math.round(fps * 100) / 100,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    codec: videoStream.codec_name ?? "unknown",
  };
}

/** Exported for unit testing. Production callers go through `extractKeyframes`. */
export function pickFrameCount(durationMs: number, requested?: number): number {
  if (requested !== undefined) {
    return Math.min(20, Math.max(1, Math.floor(requested)));
  }
  const sec = durationMs / 1000;
  if (sec <= 10) return 6;
  if (sec <= 60) return 10;
  return 14;
}

export async function extractKeyframes(
  videoPath: string,
  metadata: VideoMetadata,
  opts: ExtractKeyframesOptions = {},
): Promise<Keyframe[]> {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) throw new FFmpegMissingError("ffmpeg");

  const frameCount = pickFrameCount(metadata.durationMs, opts.maxFrames);
  const maxLongSide = opts.maxLongSide ?? 1024;
  const quality = opts.jpegQuality ?? 4;

  // Uniform sampling at the midpoint of each segment. Avoids the very first
  // and very last frames, which are often black or transitional.
  const timestampsMs: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const t = Math.round((metadata.durationMs * (i + 0.5)) / frameCount);
    timestampsMs.push(t);
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "hf-vid-"));
  const frames: Keyframe[] = [];
  try {
    // Per-frame ffmpeg invocation with input seek (`-ss` before `-i`) so we
    // jump near the keyframe before decoding. Slower than a single
    // multi-frame pass, but predictable timing and trivial to debug.
    for (let i = 0; i < timestampsMs.length; i++) {
      const t = timestampsMs[i] as number;
      const tSec = (t / 1000).toFixed(3);
      const outPath = join(tmpRoot, `frame_${String(i).padStart(3, "0")}.jpg`);
      await runCommand(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          tSec,
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-vf",
          `scale='min(${maxLongSide},iw)':-2`,
          "-q:v",
          String(quality),
          "-y",
          outPath,
        ],
        { timeoutMs: 20_000 },
      );
      const buffer = readFileSync(outPath);
      frames.push({ buffer, timestampMs: t });
    }
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return frames;
}

/**
 * Convenience wrapper. Returns metadata + frames in one call so callers
 * don't have to thread `metadata` themselves. Caller still pays attention
 * to total payload size — see `summarizeKeyframePayload`.
 */
export async function analyzeVideo(
  videoPath: string,
  opts: ExtractKeyframesOptions = {},
): Promise<{ metadata: VideoMetadata; frames: Keyframe[] }> {
  const metadata = await extractVideoMetadata(videoPath);
  const frames = await extractKeyframes(videoPath, metadata, opts);
  return { metadata, frames };
}

export function summarizeKeyframePayload(frames: Keyframe[]): {
  totalBytes: number;
  approxInputTokens: number;
} {
  const totalBytes = frames.reduce((acc, f) => acc + f.buffer.length, 0);
  // Anthropic charges roughly ~1 token per ~750 bytes of image data after
  // their internal resize. This is a loose upper bound used for telemetry.
  const approxInputTokens = Math.ceil(totalBytes / 750);
  return { totalBytes, approxInputTokens };
}

export { findFFmpeg, findFFprobe };
