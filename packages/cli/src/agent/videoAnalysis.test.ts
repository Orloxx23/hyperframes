/**
 * Tests for the video analysis helper used by the `analyze_video` MCP tool.
 *
 * Most assertions need a real video. We generate one on the fly with
 * `ffmpeg -f lavfi` so we don't have to commit binary fixtures. Tests skip
 * automatically when ffmpeg/ffprobe aren't on PATH (e.g. minimal CI images).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFFmpeg, findFFprobe } from "../browser/ffmpeg.js";
import {
  analyzeVideo,
  extractKeyframes,
  extractVideoMetadata,
  pickFrameCount,
  summarizeKeyframePayload,
} from "./videoAnalysis.js";

const ffmpeg = findFFmpeg();
const ffprobe = findFFprobe();
const integration = ffmpeg !== undefined && ffprobe !== undefined;

describe("pickFrameCount", () => {
  it("returns 6 for short videos when requested is omitted", () => {
    expect(pickFrameCount(5_000)).toBe(6);
    expect(pickFrameCount(10_000)).toBe(6);
  });

  it("returns 10 for medium videos", () => {
    expect(pickFrameCount(30_000)).toBe(10);
    expect(pickFrameCount(60_000)).toBe(10);
  });

  it("returns 14 for long videos", () => {
    expect(pickFrameCount(120_000)).toBe(14);
  });

  it("respects an explicit override, clamped to [1, 20]", () => {
    expect(pickFrameCount(10_000, 4)).toBe(4);
    expect(pickFrameCount(10_000, 0)).toBe(1);
    expect(pickFrameCount(10_000, 99)).toBe(20);
  });
});

describe("summarizeKeyframePayload", () => {
  it("reports cumulative bytes and a rough token estimate", () => {
    const frames = [
      { buffer: Buffer.alloc(1500), timestampMs: 0 },
      { buffer: Buffer.alloc(750), timestampMs: 1000 },
    ];
    const summary = summarizeKeyframePayload(frames);
    expect(summary.totalBytes).toBe(2250);
    expect(summary.approxInputTokens).toBeGreaterThan(0);
  });
});

describe.skipIf(!integration)("video analysis — integration", () => {
  let workDir: string;
  let shortVideo: string;
  let mediumVideo: string;

  function makeVideo(outPath: string, durationSec: number, size = "320x240"): void {
    // `lavfi`'s color source produces a deterministic test video without
    // needing any input file. We use a moving box overlay so frames are
    // visually distinguishable, which exercises the per-frame extraction
    // path more meaningfully.
    const result = spawnSync(
      ffmpeg!,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=blue:s=${size}:d=${durationSec}`,
        "-vf",
        // Box that slides left → right across the frame.
        `drawbox=x='mod(n*4,iw-40)':y=ih/2-20:w=40:h=40:color=white@0.9:t=fill`,
        "-r",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-y",
        outPath,
      ],
      { timeout: 30_000 },
    );
    if (result.status !== 0) {
      throw new Error(
        `ffmpeg fixture generation failed: ${result.stderr?.toString() ?? "(no stderr)"}`,
      );
    }
  }

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "hf-vid-test-"));
    shortVideo = join(workDir, "short.mp4");
    mediumVideo = join(workDir, "medium.mp4");
    makeVideo(shortVideo, 2);
    makeVideo(mediumVideo, 12);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("extracts metadata from a short generated video", async () => {
    const meta = await extractVideoMetadata(shortVideo);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.durationMs).toBeGreaterThanOrEqual(1500);
    expect(meta.durationMs).toBeLessThanOrEqual(2500);
    expect(meta.fps).toBeGreaterThan(20);
  });

  it("extracts 6 uniform keyframes from a short video by default", async () => {
    const meta = await extractVideoMetadata(shortVideo);
    const frames = await extractKeyframes(shortVideo, meta);
    expect(frames.length).toBe(6);
    for (const f of frames) {
      expect(f.buffer.length).toBeGreaterThan(100);
      // JPEG SOI marker.
      expect(f.buffer[0]).toBe(0xff);
      expect(f.buffer[1]).toBe(0xd8);
    }
    // Timestamps should be strictly monotonic.
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!.timestampMs;
      const curr = frames[i]!.timestampMs;
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("respects max_frames override and downscales", async () => {
    const meta = await extractVideoMetadata(mediumVideo);
    const frames = await extractKeyframes(mediumVideo, meta, {
      maxFrames: 4,
      maxLongSide: 128,
    });
    expect(frames.length).toBe(4);
    // 128px cap on a 320x240 source means each frame is small (<10 KB JPEG).
    for (const f of frames) {
      expect(f.buffer.length).toBeLessThan(10_000);
    }
  });

  it("analyzeVideo returns metadata + frames together", async () => {
    const result = await analyzeVideo(shortVideo, { maxFrames: 3 });
    expect(result.metadata.durationMs).toBeGreaterThan(0);
    expect(result.frames.length).toBe(3);
  });

  it("throws a clear error when the file does not exist", async () => {
    const ghost = join(workDir, "does-not-exist.mp4");
    expect(existsSync(ghost)).toBe(false);
    await expect(extractVideoMetadata(ghost)).rejects.toThrow();
  });
});
