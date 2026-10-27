mod host_commands;
mod log_rotate;
mod port;
mod restart_policy;
mod sidecar;
mod startup;

use host_commands::{
    get_app_port, open_app_logs, read_saved_app_port, retry_startup, save_port_and_retry,
    set_app_port,
};
use sidecar::{SidecarHandle, SidecarSpawnContext};
use startup::{confirm_quit_with_jobs, count_running_jobs, StartupState};
use std::sync::Arc;
use tauri::{AppHandle, Manager, RunEvent};
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
        .invoke_handler(tauri::generate_handler![
            get_app_port,
            set_app_port,
            read_saved_app_port,
            open_app_logs,
            retry_startup,
            save_port_and_retry,
        ])
        .setup(|app| {
            let resources_dir = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("fixer-resources");
            let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
            let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;

            let sidecar = SidecarHandle::new(SidecarSpawnContext {
                resources_dir,
                data_dir: data_dir.clone(),
                log_dir: log_dir.clone(),
            })
            .map_err(|e| e.to_string())?;

            let startup = Arc::new(StartupState::new(
                Arc::clone(&sidecar),
                data_dir,
                log_dir,
            ));

            app.manage(Arc::clone(&startup));
            let hook_app = app.handle().clone();
            sidecar.set_exit_hook(Arc::new(move |kind| {
                if let Some(state) = hook_app.try_state::<Arc<StartupState>>() {
                    state.handle_sidecar_exit(&hook_app, kind);
                }
            }));
            sidecar
                .start(app.handle())
                .map_err(|e| e.to_string())?;
            startup.begin_wait_for_backend(app.handle().clone());

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
            if let RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    handle_exit_request(app);
                });
            }
        });
}

fn handle_exit_request(app: AppHandle) {
    let Some(state) = app.try_state::<Arc<StartupState>>() else {
        app.exit(0);
        return;
    };
    let port = state.sidecar.configured_port();
    match count_running_jobs(port) {
        Some(0) | None => {
            state.sidecar.shutdown();
            app.exit(0);
        }
        Some(n) => confirm_quit_with_jobs(&app, n),
    }
}
