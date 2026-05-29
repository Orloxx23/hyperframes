//! Resolve runtime paths for bundled resources (Studio assets, Chromium, ffmpeg)
//! and the user's workspace directory.

use anyhow::{Context, Result};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub struct ResourcePaths {
    pub studio_dir: PathBuf,
    pub runtime_js: Option<PathBuf>,
    pub chrome_binary: PathBuf,
    pub ffmpeg_binary: PathBuf,
    pub claude_binary: PathBuf,
}

/// Resolve the on-disk locations of bundled resources. In `tauri dev`, these
/// point at the in-repo build outputs so iteration is fast. In a packaged
/// installer, Tauri extracts the `resources/**` glob to an OS-specific path
/// (`AppData\Local\com.hyperframes.studio\resources` on Windows, etc.) and
/// `app.path().resource_dir()` returns the parent of that tree.
pub fn resolve_resources(app: &AppHandle) -> Result<ResourcePaths> {
    let resource_dir = app
        .path()
        .resource_dir()
        .context("failed to resolve Tauri resource_dir")?;

    let studio_dir = resource_dir.join("resources").join("studio");
    let chrome_dir = resource_dir.join("resources").join("chrome");
    let ffmpeg_dir = resource_dir.join("resources").join("ffmpeg");
    let claude_dir = resource_dir.join("resources").join("claude");

    let chrome_exe = if cfg!(target_os = "windows") {
        "chrome-headless-shell.exe"
    } else {
        "chrome-headless-shell"
    };
    let ffmpeg_exe = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let claude_exe = if cfg!(target_os = "windows") {
        "claude.exe"
    } else {
        "claude"
    };

    let chrome_binary = chrome_dir.join(chrome_exe);
    let ffmpeg_binary = ffmpeg_dir.join(ffmpeg_exe);
    let claude_binary = claude_dir.join(claude_exe);

    // Try a few common runtime filenames. `prepare-studio.ts` copies whichever
    // the current CLI build emits.
    let runtime_candidates = [
        studio_dir.join("hyperframe-runtime.js"),
        studio_dir.join("hyperframe.runtime.iife.js"),
        resource_dir
            .join("resources")
            .join("runtime")
            .join("hyperframe-runtime.js"),
    ];
    let runtime_js = runtime_candidates.into_iter().find(|p| p.exists());

    Ok(ResourcePaths {
        studio_dir,
        runtime_js,
        chrome_binary,
        ffmpeg_binary,
        claude_binary,
    })
}

/// User-facing workspace root. Convention: `<Documents>/HyperFrames`. Created
/// on first launch — the CLI's workspace mode handles an empty dir gracefully
/// (renders the Studio splash with a project picker).
pub fn resolve_workspace(app: &AppHandle) -> Result<PathBuf> {
    let docs = app
        .path()
        .document_dir()
        .context("failed to resolve document_dir")?;
    let workspace = docs.join("HyperFrames");
    if !workspace.exists() {
        std::fs::create_dir_all(&workspace)
            .with_context(|| format!("failed to create workspace dir at {workspace:?}"))?;
    }
    Ok(workspace)
}
