use crate::path_guard;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn planned_removal_dirs(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let resolver = app.path();
    let identifier = app.config().identifier.clone();
    let mut dirs = vec![
        resolver
            .app_local_data_dir()
            .map_err(|e| e.to_string())?,
        resolver.app_log_dir().map_err(|e| e.to_string())?,
    ];
    dirs.extend(extra_webview_dirs(app, &identifier)?);
    Ok(dedupe_paths(dirs))
}

pub async fn wipe_app_data(app: &AppHandle) -> Result<(), String> {
    let planned = planned_removal_dirs(app)?;

    #[cfg(target_os = "macos")]
    {
        let ids = app
            .fetch_data_store_identifiers()
            .await
            .map_err(|e| e.to_string())?;
        for id in ids {
            app.remove_data_store(id)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    for dir in &planned {
        remove_dir_if_allowed(&planned, dir)?;
    }
    Ok(())
}

fn remove_dir_if_allowed(planned: &[PathBuf], target: &Path) -> Result<(), String> {
    if !path_guard::may_remove_dir(planned, target) {
        return Err(format!("refusing to remove {}", target.display()));
    }
    if target.is_dir() {
        std::fs::remove_dir_all(target).map_err(|e| e.to_string())?;
    } else if target.is_file() {
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    'next: for path in paths {
        for existing in &out {
            if existing == &path {
                continue 'next;
            }
        }
        out.push(path);
    }
    out
}

fn extra_webview_dirs(app: &AppHandle, identifier: &str) -> Result<Vec<PathBuf>, String> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        dirs.push(home.join("Library/WebKit").join(identifier));
        dirs.push(home.join("Library/Caches").join(identifier));
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(cache) = app.path().app_cache_dir() {
            dirs.push(cache);
        }
        if let Ok(data) = app.path().app_data_dir() {
            dirs.push(data);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let local = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?;
        dirs.push(local.join("EBWebView"));
    }

    Ok(dirs)
}
