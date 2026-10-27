use crate::port::{resolve_port, write_port_file};
use crate::restart_policy::{RestartPolicy, SidecarDeathAction};
use crate::sidecar::SidecarHandle;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub struct StartupState {
    pub sidecar: Arc<SidecarHandle>,
    pub data_dir: std::path::PathBuf,
    pub log_dir: std::path::PathBuf,
    restart_policy: Mutex<RestartPolicy>,
    backend_ready: AtomicBool,
    wait_generation: AtomicU64,
}

impl StartupState {
    pub fn new(
        sidecar: Arc<SidecarHandle>,
        data_dir: std::path::PathBuf,
        log_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            sidecar,
            data_dir,
            log_dir,
            restart_policy: Mutex::new(RestartPolicy::default()),
            backend_ready: AtomicBool::new(false),
            wait_generation: AtomicU64::new(0),
        }
    }

    pub fn begin_wait_for_backend(&self, app: AppHandle) {
        if !self.sidecar.has_live_child() {
            return;
        }
        let gen = self.wait_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        thread::spawn(move || {
            let Some(state) = app.try_state::<Arc<StartupState>>() else {
                return;
            };
            state.wait_loop(app.clone(), gen);
        });
    }

    pub fn retry(&self, app: &AppHandle) -> Result<(), String> {
        self.backend_ready.store(false, Ordering::SeqCst);
        if let Ok(mut policy) = self.restart_policy.lock() {
            policy.reset();
        }
        navigate_to_loading(app)?;
        let port = resolve_port(&self.data_dir);
        self.sidecar
            .respawn(app, port)
            .map_err(|e| e.to_string())?;
        self.begin_wait_for_backend(app.clone());
        Ok(())
    }

    pub fn save_port_and_retry(&self, app: &AppHandle, port: u16) -> Result<(), String> {
        if port == 0 {
            return Err("Port must be greater than zero".into());
        }
        write_port_file(&self.data_dir, port).map_err(|e| e.to_string())?;
        self.backend_ready.store(false, Ordering::SeqCst);
        if let Ok(mut policy) = self.restart_policy.lock() {
            policy.reset();
        }
        navigate_to_loading(app)?;
        self.sidecar.respawn(app, port).map_err(|e| e.to_string())?;
        self.begin_wait_for_backend(app.clone());
        Ok(())
    }

    pub fn on_backend_healthy(&self) {
        self.backend_ready.store(true, Ordering::SeqCst);
    }

    pub fn handle_sidecar_exit(&self, app: &AppHandle, kind: &str) {
        if self.backend_ready.load(Ordering::SeqCst) {
            let action = {
                let mut policy = self.restart_policy.lock().expect("restart policy");
                policy.record_death(Instant::now())
            };
            match action {
                SidecarDeathAction::RestartOnce => {
                    self.backend_ready.store(false, Ordering::SeqCst);
                    let _ = navigate_to_loading(app);
                    let port = resolve_port(&self.data_dir);
                    if self.sidecar.respawn(app, port).is_ok() {
                        self.begin_wait_for_backend(app.clone());
                    }
                }
                SidecarDeathAction::ShowError => {
                    self.backend_ready.store(false, Ordering::SeqCst);
                    let _ = navigate_to_loading(app);
                    show_startup_error(app, "crash", None);
                }
            }
            return;
        }

        if kind == "port_in_use" {
            let port = self.sidecar.configured_port();
            let _ = navigate_to_loading(app);
            show_startup_error(app, "port_in_use", Some(port));
        } else {
            let action = {
                let mut policy = self.restart_policy.lock().expect("restart policy");
                policy.record_death(Instant::now())
            };
            match action {
                SidecarDeathAction::RestartOnce => {
                    let port = resolve_port(&self.data_dir);
                    let _ = navigate_to_loading(app);
                    if self.sidecar.respawn(app, port).is_ok() {
                        self.begin_wait_for_backend(app.clone());
                    }
                }
                SidecarDeathAction::ShowError => {
                    let _ = navigate_to_loading(app);
                    show_startup_error(app, "crash", None);
                }
            }
        }
    }

    fn wait_loop(self: &Arc<Self>, app: AppHandle, generation: u64) {
        let port = self.sidecar.configured_port();
        let url = format!("http://127.0.0.1:{port}/");
        let health = format!("http://127.0.0.1:{port}/api/health");
        let host = format!("127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(60);

        loop {
            if self.wait_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if Instant::now() >= deadline {
                let _ = navigate_to_loading(&app);
                show_startup_error(&app, "timeout", None);
                return;
            }
            if health_ok(&health, &host) {
                self.on_backend_healthy();
                if let Some(window) = app.get_webview_window("main") {
                    let parsed = Url::parse(&url).expect("loopback url");
                    let _ = window.navigate(parsed);
                }
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
}

pub fn navigate_to_loading(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let url = Url::parse("tauri://localhost/index.html").map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())?;
    let _ = window.eval("window.__fixerResetLoading && window.__fixerResetLoading()");
    Ok(())
}

pub fn show_startup_error(app: &AppHandle, reason: &str, port: Option<u16>) {
    let port_json = port.map(|p| p.to_string()).unwrap_or_else(|| "null".into());
    let script = format!(
        "window.__fixerShowStartupError && window.__fixerShowStartupError({{ reason: {reason:?}, port: {port_json} }});"
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&script);
    }
}

pub fn open_log_folder(log_dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(log_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(log_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(log_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn loopback_agent() -> ureq::Agent {
    ureq::config::Config::builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .new_agent()
}

pub fn count_running_jobs(port: u16) -> Option<usize> {
    let url = format!("http://127.0.0.1:{port}/api/jobs/active");
    let host = format!("127.0.0.1:{port}");
    loopback_agent()
        .get(&url)
        .header("Host", &host)
        .call()
        .ok()
        .and_then(|mut r| {
            if r.status() != 200 {
                return None;
            }
            r.body_mut()
                .read_json::<Vec<serde_json::Value>>()
                .ok()
                .map(|jobs| jobs.len())
        })
}

pub fn confirm_quit_with_jobs(app: &AppHandle, running: usize) {
    let message = format!(
        "{running} running job{} will be interrupted.",
        if running == 1 { "" } else { "s" }
    );
    let app = app.clone();
    app.dialog()
        .message(message)
        .title("Quit Fixer?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if confirmed {
                if let Some(state) = app.try_state::<Arc<StartupState>>() {
                    state.sidecar.shutdown();
                }
                crate::approve_exit(&app);
            }
        });
}

fn health_ok(url: &str, host: &str) -> bool {
    loopback_agent()
        .get(url)
        .header("Host", host)
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}
