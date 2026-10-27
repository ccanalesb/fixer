mod log_rotate;
mod port;
mod sidecar;

use port::app_port;
use sidecar::SidecarHandle;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent};
use tauri::Url;

struct AppState {
    sidecar: Arc<SidecarHandle>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let resources_dir = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("fixer-resources");
            let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
            let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;

            let sidecar = SidecarHandle::spawn(app.handle(), &resources_dir, &data_dir, &log_dir)
                .map_err(|e| e.to_string())?;
            let sidecar = Arc::new(sidecar);

            app.manage(AppState {
                sidecar: Arc::clone(&sidecar),
            });

            let handle = app.handle().clone();
            thread::spawn(move || wait_for_backend_and_navigate(handle));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.sidecar.shutdown();
                }
            }
        });
}

fn wait_for_backend_and_navigate(app: AppHandle) {
    let port = app_port();
    let url = format!("http://127.0.0.1:{port}/");
    let health = format!("http://127.0.0.1:{port}/api/health");
    let host = format!("127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(60);

    loop {
        if Instant::now() >= deadline {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.__fixerShowStartupTimeout && window.__fixerShowStartupTimeout()");
            }
            return;
        }

        if health_ok(&health, &host) {
            if let Some(window) = app.get_webview_window("main") {
                let parsed = Url::parse(&url).expect("loopback url");
                let _ = window.navigate(parsed);
            }
            return;
        }

        thread::sleep(Duration::from_millis(200));
    }
}

fn health_ok(url: &str, host: &str) -> bool {
    ureq::get(url)
        .header("Host", host)
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}
