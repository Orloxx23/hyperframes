//! Spawn and supervise the `hyperframes` CLI sidecar.
//!
//! The CLI is shipped as a single-file binary built with `bun build --compile`
//! (see `packages/desktop/scripts/prepare-binaries.ts`). Tauri's sidecar
//! plumbing handles platform-specific executable resolution via
//! `<binary>-<target-triple>[.exe]` naming.

use crate::paths::ResourcePaths;
use anyhow::{Context, Result};
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Handle to the running sidecar, stored so we can kill it on shutdown.
pub struct SidecarHandle(pub Mutex<Option<CommandChild>>);

impl SidecarHandle {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn store(&self, child: CommandChild) {
        if let Ok(mut guard) = self.0.lock() {
            // If a previous instance is somehow still alive, kill it first.
            if let Some(prev) = guard.take() {
                let _ = prev.kill();
            }
            *guard = Some(child);
        }
    }

    pub fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// Spawn `hyperframes preview <workspace> --port <port> --no-open` as a
/// sidecar, with env vars pointing at the bundled resources.
///
/// stdout/stderr are streamed to the Rust log so build issues surface in
/// `tauri dev` instead of disappearing into a void.
pub fn spawn(
    app: &AppHandle,
    workspace: &Path,
    port: u16,
    resources: &ResourcePaths,
) -> Result<CommandChild> {
    let mut command = app
        .shell()
        .sidecar("hyperframes")
        .context("failed to locate hyperframes sidecar binary")?
        .args([
            "preview",
            workspace.to_string_lossy().as_ref(),
            "--port",
            &port.to_string(),
            "--no-open",
        ])
        .env("HYPERFRAMES_STUDIO_DIR", &resources.studio_dir)
        // Force telemetry off — desktop users never opted in via the CLI prompt.
        .env("HYPERFRAMES_TELEMETRY", "");

    // Only point at bundled Chromium if it actually exists. During `tauri dev`
    // before `prepare:chromium` has run, the resource dir is empty — falling
    // back to the CLI's own resolution (system Chrome, then lazy-download)
    // is more useful than a hard failure.
    if resources.chrome_binary.exists() {
        command = command.env("PRODUCER_HEADLESS_SHELL_PATH", &resources.chrome_binary);
    } else {
        log::warn!(
            "Bundled Chromium not present at {:?}; sidecar will fall back to its own resolution.",
            resources.chrome_binary
        );
    }

    // ffmpeg is spawned by the engine via `spawn("ffmpeg", ...)` — no env var
    // override is consulted. We prepend the bundled ffmpeg dir to PATH so
    // the OS resolver picks the bundled binary first.
    if let Some(parent) = resources.ffmpeg_binary.parent() {
        if parent.exists() {
            let existing = std::env::var("PATH").unwrap_or_default();
            let sep = if cfg!(windows) { ";" } else { ":" };
            let new_path = format!("{}{}{}", parent.display(), sep, existing);
            command = command.env("PATH", new_path);
        } else {
            log::warn!(
                "Bundled ffmpeg not present at {:?}; sidecar will fall back to PATH ffmpeg.",
                resources.ffmpeg_binary
            );
        }
    }

    if let Some(runtime) = &resources.runtime_js {
        command = command.env("HYPERFRAMES_RUNTIME_JS", runtime);
    }

    // The @anthropic-ai/claude-agent-sdk needs a real on-disk `claude` binary
    // to spawn as the agent subprocess. `bun --compile` externalizes the
    // platform-specific optional dep that ships it, so we bundle the binary
    // as a Tauri resource and point the SDK at it via this env var.
    // agentLoop.ts reads it and forwards to `options.pathToClaudeCodeExecutable`.
    if resources.claude_binary.exists() {
        command = command.env("HYPERFRAMES_CLAUDE_CLI_PATH", &resources.claude_binary);
    } else {
        log::warn!(
            "Bundled claude CLI not present at {:?}; in-Studio chat will not work until prepare:claude-cli runs.",
            resources.claude_binary
        );
    }

    let (mut rx, child) = command.spawn().context("failed to spawn sidecar")?;

    // Stream the sidecar's stdio into the Rust log so issues during the
    // startup race (the user sees an empty webview until readiness) leave a
    // breadcrumb trail in dev/CI logs.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    log::info!("[hyperframes] {}", text.trim_end());
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    log::warn!("[hyperframes!] {}", text.trim_end());
                }
                CommandEvent::Error(e) => log::error!("[hyperframes-err] {e}"),
                CommandEvent::Terminated(payload) => {
                    log::warn!("[hyperframes] terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}
