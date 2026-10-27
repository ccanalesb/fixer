use crate::startup::StartupState;
#[cfg(not(target_os = "macos"))]
use crate::startup::count_running_jobs;
#[cfg(not(target_os = "macos"))]
use crate::{approve_exit, mark_exit_approved};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_dialog::MessageDialogResult;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

pub const LAST_CHECK_FILE: &str = "updater-last-check";
pub const CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

const DEFAULT_ENDPOINT: &str =
    "https://github.com/ccanalesb/fixer/releases/latest/download/latest.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualCheckResult {
    UpToDate,
    CheckFailed,
    UpdateAvailable,
}

impl ManualCheckResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UpToDate => "up_to_date",
            Self::CheckFailed => "check_failed",
            Self::UpdateAvailable => "update_available",
        }
    }
}

pub fn last_check_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LAST_CHECK_FILE)
}

pub fn read_last_check_unix(data_dir: &Path) -> Option<u64> {
    let raw = std::fs::read_to_string(last_check_path(data_dir)).ok()?;
    raw.trim().parse().ok()
}

pub fn write_last_check_unix(data_dir: &Path, unix_secs: u64) -> io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = last_check_path(data_dir);
    let mut file = std::fs::File::create(path)?;
    writeln!(file, "{unix_secs}")?;
    Ok(())
}

/// Returns true when an automatic check may run (never checked, or interval elapsed).
pub fn automatic_check_due(last_check_unix: Option<u64>, now_unix: u64, interval_secs: u64) -> bool {
    match last_check_unix {
        None => true,
        Some(last) => now_unix.saturating_sub(last) >= interval_secs,
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn release_page_url(version: &str) -> String {
    let tag = version.strip_prefix('v').unwrap_or(version);
    format!("https://github.com/ccanalesb/fixer/releases/tag/v{tag}")
}

fn endpoint_urls() -> Result<Vec<Url>, String> {
    let raw = if let Ok(url) = std::env::var("LT_UPDATER_ENDPOINT") {
        if !url.trim().is_empty() {
            vec![url.trim().to_string()]
        } else {
            vec![DEFAULT_ENDPOINT.to_string()]
        }
    } else {
        vec![DEFAULT_ENDPOINT.to_string()]
    };
    raw.into_iter()
        .map(|s| Url::parse(&s).map_err(|e| e.to_string()))
        .collect()
}

async fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    builder = builder
        .endpoints(endpoint_urls()?)
        .map_err(|e| e.to_string())?;
    builder.build().map_err(|e| e.to_string())
}

async fn run_check(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = build_updater(app).await?;
    updater.check().await.map_err(|e| e.to_string())
}

fn record_successful_check(data_dir: &Path) {
    let now = now_unix();
    if let Err(e) = write_last_check_unix(data_dir, now) {
        eprintln!("updater: could not write last-check file: {e}");
    }
}

pub fn spawn_automatic_scheduler(app: AppHandle, data_dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(CHECK_INTERVAL);
        let last = read_last_check_unix(&data_dir);
        let now = now_unix();
        if !automatic_check_due(last, now, CHECK_INTERVAL.as_secs()) {
            continue;
        }
        let app = app.clone();
        let data_dir = data_dir.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_automatic_check(&app, &data_dir).await {
                eprintln!("updater: automatic check failed: {e}");
            }
        });
    });
}

pub async fn maybe_run_automatic_check(app: &AppHandle, data_dir: &Path) {
    let last = read_last_check_unix(data_dir);
    let now = now_unix();
    if !automatic_check_due(last, now, CHECK_INTERVAL.as_secs()) {
        return;
    }
    if let Err(e) = run_automatic_check(app, data_dir).await {
        eprintln!("updater: automatic check failed: {e}");
    }
}

async fn run_automatic_check(app: &AppHandle, data_dir: &Path) -> Result<(), String> {
    let update = run_check(app).await?;
    record_successful_check(data_dir);
    if let Some(update) = update {
        show_update_notice(app, update).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_for_updates_manual(
    app: AppHandle,
    state: tauri::State<'_, Arc<StartupState>>,
) -> Result<String, String> {
    let data_dir = state.data_dir.clone();
    let update = match run_check(&app).await {
        Ok(u) => {
            record_successful_check(&data_dir);
            u
        }
        Err(e) => {
            eprintln!("updater: manual check failed: {e}");
            return Ok(ManualCheckResult::CheckFailed.as_str().to_string());
        }
    };
    if let Some(update) = update {
        show_update_notice(&app, update).await;
        return Ok(ManualCheckResult::UpdateAvailable.as_str().to_string());
    }
    Ok(ManualCheckResult::UpToDate.as_str().to_string())
}

async fn show_update_notice(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let version = update.version.clone();
    let release_url = release_page_url(&version);
    let message = format!("Version {version} is available.");

    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let release_url = release_url.clone();
        app.dialog()
            .message(message)
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "What's new".into(),
                "OK".into(),
            ))
            .show(move |confirmed| {
                if confirmed {
                    let _ = app.opener().open_url(&release_url, None::<&str>);
                }
            });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let app = app.clone();
        let release_url = release_url.clone();
        let update = update.clone();
        app.dialog()
            .message(message)
            .title("Update available")
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Install and restart".into(),
                "Later".into(),
                "What's new".into(),
            ))
            .show_with_result(move |choice| {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match choice {
                        MessageDialogResult::Yes => {
                            install_update_with_job_guard(&app, update).await;
                        }
                        MessageDialogResult::Cancel => {
                            let _ = app.opener().open_url(&release_url, None::<&str>);
                        }
                        _ => {}
                    }
                });
            });
    }
}

#[cfg(not(target_os = "macos"))]
async fn install_update_with_job_guard(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let port = app
        .try_state::<Arc<StartupState>>()
        .map(|s| s.sidecar.configured_port())
        .unwrap_or(0);

    if let Some(n) = count_running_jobs(port) {
        if n > 0 && !confirm_jobs_before_update(app, n).await {
            return;
        }
    }

    if let Some(state) = app.try_state::<Arc<StartupState>>() {
        state.sidecar.shutdown();
    }
    mark_exit_approved();

    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        eprintln!("updater: install failed: {e}");
        return;
    }

    #[cfg(windows)]
    {
        // NSIS installer takes over exit; approval flag avoids the quit-with-jobs loop.
        return;
    }

    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        use tauri_plugin_process::ProcessExt;
        approve_exit(app);
        let _ = app.process().relaunch();
    }
}

#[cfg(not(target_os = "macos"))]
async fn confirm_jobs_before_update(app: &AppHandle, running: usize) -> bool {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let message = format!(
        "{running} running job{} will be interrupted.",
        if running == 1 { "" } else { "s" }
    );
    let app = app.clone();
    app.dialog()
        .message(message)
        .title("Install update?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    rx.recv().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn automatic_check_due_when_never_checked() {
        assert!(automatic_check_due(None, 1_000_000, CHECK_INTERVAL.as_secs()));
    }

    #[test]
    fn automatic_check_not_due_within_interval() {
        let last = 1_000_000u64;
        let now = last + CHECK_INTERVAL.as_secs() - 1;
        assert!(!automatic_check_due(Some(last), now, CHECK_INTERVAL.as_secs()));
    }

    #[test]
    fn automatic_check_due_after_interval() {
        let last = 1_000_000u64;
        let now = last + CHECK_INTERVAL.as_secs();
        assert!(automatic_check_due(Some(last), now, CHECK_INTERVAL.as_secs()));
    }

    #[test]
    fn last_check_file_round_trip() {
        let dir = TempDir::new().expect("tempdir");
        write_last_check_unix(dir.path(), 42).expect("write");
        assert_eq!(read_last_check_unix(dir.path()), Some(42));
    }
}
