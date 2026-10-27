use crate::port::{read_port_file, resolve_port, write_port_file};
use crate::startup::{open_log_folder, StartupState};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_app_port(state: State<'_, Arc<StartupState>>) -> u16 {
    resolve_port(&state.data_dir)
}

#[tauri::command]
pub fn set_app_port(state: State<'_, Arc<StartupState>>, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Port must be greater than zero".into());
    }
    write_port_file(&state.data_dir, port).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_saved_app_port(state: State<'_, Arc<StartupState>>) -> Option<u16> {
    read_port_file(&state.data_dir)
}

#[tauri::command]
pub fn open_app_logs(state: State<'_, Arc<StartupState>>) -> Result<(), String> {
    open_log_folder(&state.log_dir)
}

#[tauri::command]
pub fn retry_startup(state: State<'_, Arc<StartupState>>, app: AppHandle) -> Result<(), String> {
    state.retry(&app)
}

#[tauri::command]
pub fn save_port_and_retry(
    state: State<'_, Arc<StartupState>>,
    app: AppHandle,
    port: u16,
) -> Result<(), String> {
    state.save_port_and_retry(&app, port)
}
