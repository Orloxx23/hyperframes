//! HyperFrames desktop shell — entry point.
//!
//! Boot sequence:
//! 1. Resolve bundled resources (Studio bundle, Chromium, ffmpeg) under
//!    `resource_dir/resources/...`.
//! 2. Pick a free port in 17777..17877.
//! 3. Spawn the `hyperframes` sidecar pointing at the user's workspace.
//! 4. Poll `/__hyperframes_config` until ready.
//! 5. Navigate the main window at `http://127.0.0.1:<port>` and show it.

mod paths;
mod port;
mod sidecar;

use sidecar::SidecarHandle;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use url::Url;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init()
        .ok();

    let sidecar_state = Arc::new(SidecarHandle::new());
    let sidecar_for_setup = sidecar_state.clone();
    let sidecar_for_event = sidecar_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            commands::pick_media_files,
            commands::pick_workspace_dir,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let sidecar = sidecar_for_setup.clone();

            tauri::async_runtime::spawn(async move {
                if let Err(err) = boot(&handle, sidecar).await {
                    log::error!("Boot failure: {err:#}");
                    show_error_window(&handle, &format!("{err:#}"));
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                sidecar_for_event.kill();
            }
        });
}

async fn boot(app: &tauri::AppHandle, sidecar_handle: Arc<SidecarHandle>) -> anyhow::Result<()> {
    let resources = paths::resolve_resources(app)?;
    log::info!(
        "Resources: studio={:?} chrome={:?} ffmpeg={:?} claude={:?}",
        resources.studio_dir,
        resources.chrome_binary,
        resources.ffmpeg_binary,
        resources.claude_binary,
    );

    let workspace = paths::resolve_workspace(app)?;
    log::info!("Workspace: {workspace:?}");

    let port = port::find_free_port()?;
    log::info!("Selected port {port}");

    let child = sidecar::spawn(app, &workspace, port, &resources)?;
    sidecar_handle.store(child);

    port::wait_for_ready(port).await?;
    log::info!("Sidecar reported ready on port {port}");

    let url = format!("http://127.0.0.1:{port}");

    // Reuse the existing "main" window from tauri.conf.json — building a new
    // one with the same label panics. We just navigate and show it.
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow::anyhow!("main window not configured in tauri.conf.json"))?;
    let parsed: Url = url.parse()?;
    main_window.navigate(parsed)?;
    main_window.show()?;
    main_window.set_focus().ok();

    Ok(())
}

fn show_error_window(app: &tauri::AppHandle, message: &str) {
    let html = format!(
        "<!doctype html><html><head><meta charset='utf-8'><title>HyperFrames failed to start</title>\
        <style>body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0d0f14;color:#eef2f7;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}}\
        main{{max-width:640px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:28px;background:#151923}}\
        h1{{margin:0 0 12px;font-size:22px}}pre{{background:#090b10;color:#ff8da1;padding:12px;border-radius:6px;white-space:pre-wrap;overflow-x:auto;font-size:12px;line-height:1.5}}</style></head>\
        <body><main><h1>HyperFrames failed to start</h1><p>The local server could not be launched. Try restarting the app. If the issue persists, send the message below to support:</p><pre>{}</pre></main></body></html>",
        html_escape(message)
    );
    let data_url = format!("data:text/html;charset=utf-8,{}", urlencode(&html));
    let parsed: Url = match data_url.parse() {
        Ok(u) => u,
        Err(_) => return,
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(parsed);
        let _ = window.show();
    } else {
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
            .title("HyperFrames — startup error")
            .inner_size(720.0, 480.0)
            .build();
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

mod commands {
    use serde::Deserialize;
    use tauri::AppHandle;
    use tauri_plugin_dialog::DialogExt;

    /// Open a native file picker for media imports. The Studio's React UI can
    /// invoke this via `invoke('pick_media_files')` and then POST the resulting
    /// absolute paths to the existing `/api/projects/:id/copy-file` endpoint.
    /// This bypasses the multipart upload path for large files.
    #[tauri::command]
    pub async fn pick_media_files(app: AppHandle) -> Result<Vec<String>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .add_filter(
                "Media",
                &["mp4", "webm", "mov", "m4v", "mp3", "wav", "m4a", "ogg"],
            )
            .pick_files(move |files| {
                let _ = tx.send(files);
            });

        let files = rx.await.map_err(|e| e.to_string())?;
        Ok(files
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok().map(|p| p.to_string_lossy().into_owned()))
            .collect())
    }

    /// Open a directory picker so the user can switch the workspace root.
    /// Returns the absolute path; the React side then POSTs it to
    /// `/api/workspace/set-root` which calls `setWorkspaceRoot` on the
    /// shared studio API adapter.
    #[derive(Deserialize)]
    pub struct WorkspaceArgs {
        #[allow(dead_code)]
        pub current: Option<String>,
    }

    #[tauri::command]
    pub async fn pick_workspace_dir(
        app: AppHandle,
        _args: WorkspaceArgs,
    ) -> Result<Option<String>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_folder(move |dir| {
            let _ = tx.send(dir);
        });

        let dir = rx.await.map_err(|e| e.to_string())?;
        Ok(dir.and_then(|p| p.into_path().ok().map(|p| p.to_string_lossy().into_owned())))
    }
}
