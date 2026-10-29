mod delete_data;
mod host_commands;
mod log_rotate;
mod path_guard;
mod port;
mod restart_policy;
mod sidecar;
mod startup;
mod updater;

use host_commands::{
    get_app_port, open_app_logs, read_saved_app_port, retry_startup, save_port_and_retry,
    set_app_port,
};
use updater::check_for_updates_manual;
use sidecar::{SidecarHandle, SidecarSpawnContext};
use startup::{confirm_quit_with_jobs, count_running_jobs, StartupState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, RunEvent};

static EXIT_APPROVED: AtomicBool = AtomicBool::new(false);

/// Every programmatic quit goes through here: `app.exit` raises `ExitRequested` again,
/// and only an approved exit may pass the quit-with-jobs check.
pub(crate) fn mark_exit_approved() {
    EXIT_APPROVED.store(true, Ordering::SeqCst);
}

pub(crate) fn approve_exit(app: &AppHandle) {
    mark_exit_approved();
    app.exit(0);
}

#[tauri::command]
async fn delete_all_data_and_quit(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<Arc<StartupState>>() {
        state.sidecar.shutdown();
    }
    delete_data::wipe_app_data(&app).await?;
    approve_exit(&app);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            delete_all_data_and_quit,
            check_for_updates_manual,
        ])
        .setup(|app| {
            let resources_dir = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("fixer-resources");
            let resources_dir = sidecar::plain_path(resources_dir);
            let data_dir = sidecar::plain_path(app.path().app_local_data_dir().map_err(|e| e.to_string())?);
            let log_dir = sidecar::plain_path(app.path().app_log_dir().map_err(|e| e.to_string())?);

            let sidecar = SidecarHandle::new(SidecarSpawnContext {
                resources_dir,
                data_dir: data_dir.clone(),
                log_dir: log_dir.clone(),
            })
            .map_err(|e| e.to_string())?;

            let data_dir_for_updater = data_dir.clone();
            let startup = Arc::new(StartupState::new(
                Arc::clone(&sidecar),
                data_dir,
                log_dir,
            ));

            app.manage(Arc::clone(&startup));
            updater::spawn_automatic_scheduler(app.handle().clone(), data_dir_for_updater);
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
                if EXIT_APPROVED.load(Ordering::SeqCst) {
                    return;
                }
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
        approve_exit(&app);
        return;
    };
    let port = state.sidecar.configured_port();
    match count_running_jobs(port) {
        Some(0) | None => {
            state.sidecar.shutdown();
            approve_exit(&app);
        }
        Some(n) => confirm_quit_with_jobs(&app, n),
    }
}

#[cfg(test)]
mod capability_tests {
    #[test]
    fn loopback_spa_may_open_native_dialogs() {
        let caps = include_str!(concat!(env!("OUT_DIR"), "/capabilities.json"));
        assert!(
            caps.contains(r#""remote-loopback""#),
            "expected remote-loopback capability"
        );
        assert!(
            caps.contains("http://127.0.0.1:*"),
            "expected loopback remote origin pattern"
        );
        assert!(
            caps.contains("dialog:allow-open"),
            "expected dialog open permission"
        );
    }
}

