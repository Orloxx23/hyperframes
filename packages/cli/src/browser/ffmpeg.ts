import { execSync } from "node:child_process";

function which(binary: string): string | undefined {
  try {
    const cmd = process.platform === "win32" ? `where ${binary}` : `which ${binary}`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const first = output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}

export function findFFmpeg(): string | undefined {
  return which("ffmpeg");
}

export function findFFprobe(): string | undefined {
  return which("ffprobe");
}

export function getFFmpegInstallHint(): string {
  switch (process.platform) {
    case "darwin":
      return "brew install ffmpeg";
    case "linux":
      return "sudo apt install ffmpeg";
    default:
      return "https://ffmpeg.org/download.html";
  }
}
