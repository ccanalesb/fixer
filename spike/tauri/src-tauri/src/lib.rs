use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize, Deserialize)]
struct SpikeResult {
    platform: String,
    arch: String,
    packaged: bool,
    tauri_crate: &'static str,
    webview_user_agent: Option<String>,
    node_sidecar: String,
    spawn_mode: String,
    backend_root: String,
    data_dir: String,
    port: u16,
    http_status: Value,
    native_smoke: Value,
    socket_io: Value,
    sidecar_killed_on_exit: bool,
    ok: bool,
}

struct SpikeRuntime {
    port: u16,
    data_dir: PathBuf,
    backend_root: PathBuf,
    sidecar: Mutex<Option<CommandChild>>,
    finished: Mutex<bool>,
}

fn pick_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| e.to_string())
        .and_then(|l| l.local_addr().map_err(|e| e.to_string()))
        .map(|a| a.port())
}

fn backend_resources_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.push("backend-pack");
        if p.is_dir() {
            return Ok(p);
        }
    }
    app.path()
        .resolve("backend", BaseDirectory::Resource)
        .map_err(|e| e.to_string())
}

fn write_minimal_config(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("config.yaml"),
        "workers: 1\napp_models_dir: fixtures\n",
    )
    .map_err(|e| e.to_string())
}

async fn wait_for_http(url: &str, timeout: Duration) -> Result<Value, String> {
    let start = std::time::Instant::now();
    loop {
        match reqwest::get(url).await {
            Ok(res) if res.status().is_success() => {
                return res.json().await.map_err(|e| e.to_string());
            }
            _ if start.elapsed() > timeout => {
                return Err(format!("timeout waiting for {url}"));
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
}

fn kill_sidecar(child: &mut Option<CommandChild>) {
    if let Some(c) = child.take() {
        let _ = c.kill();
    }
}

#[tauri::command]
fn spike_port(state: State<'_, Arc<SpikeRuntime>>) -> u16 {
    state.port
}

#[tauri::command]
async fn report_socket_smoke(
    app: AppHandle,
    state: State<'_, Arc<SpikeRuntime>>,
    payload: Value,
) -> Result<(), String> {
    if *state.finished.lock().unwrap() {
        return Ok(());
    }
    *state.finished.lock().unwrap() = true;
    finish_spike(app, state.inner().clone(), payload).await;
    Ok(())
}

async fn finish_spike(app: AppHandle, rt: Arc<SpikeRuntime>, socket_io: Value) {
    let status_url = format!("http://127.0.0.1:{}/api/status", rt.port);
    let http_status = wait_for_http(&status_url, Duration::from_secs(10))
        .await
        .unwrap_or(Value::String("unavailable".into()));

    let result_path = rt.data_dir.join("spike-result.json");
    let native_smoke: Value = std::fs::read_to_string(&result_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::String("missing spike-result.json".into()));

    let native_ok = native_smoke
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let socket_ok = socket_io.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let http_ok = http_status.get("status").and_then(|v| v.as_str()) == Some("ok");

    let webview_user_agent = socket_io
        .get("userAgent")
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut sidecar = rt.sidecar.lock().unwrap();
    kill_sidecar(&mut *sidecar);

    let result = SpikeResult {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        packaged: !cfg!(debug_assertions),
        tauri_crate: "2",
        webview_user_agent,
        node_sidecar: "node (nodejs.org v24 sidecar)".into(),
        spawn_mode: "tauri-plugin-shell sidecar".into(),
        backend_root: rt.backend_root.display().to_string(),
        data_dir: rt.data_dir.display().to_string(),
        port: rt.port,
        http_status,
        native_smoke,
        socket_io,
        sidecar_killed_on_exit: true,
        ok: http_ok && native_ok && socket_ok,
    };

    let out_path = std::env::var("SPIKE_OUTPUT_JSON").unwrap_or_else(|_| {
        rt.data_dir
            .join("final-spike-result.json")
            .display()
            .to_string()
    });
    let json = serde_json::to_string_pretty(&result).unwrap();
    let _ = std::fs::write(&out_path, &json);
    eprintln!("SPIKE_RESULT_JSON={out_path}");
    eprintln!("{json}");

    app.exit(if result.ok { 0 } else { 1 });
}

async fn spawn_backend_sidecar(app: &AppHandle, rt: Arc<SpikeRuntime>) -> Result<(), String> {
    let entry = rt.backend_root.join("spike-entry.mjs");
    if !entry.is_file() {
        return Err(format!("missing {}", entry.display()));
    }

    let port_s = rt.port.to_string();
    let sidecar_cmd = app
        .shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args(["spike-entry.mjs"])
        .current_dir(&rt.backend_root)
        .env("FLASK_HOST", "127.0.0.1")
        .env("FLASK_PORT", &port_s)
        .env("SPIKE_DATA_DIR", rt.data_dir.display().to_string())
        .env(
            "SPIKE_RESULT_PATH",
            rt.data_dir.join("spike-result.json").display().to_string(),
        )
        .env(
            "DATABASE_PATH",
            rt.data_dir.join("visualizer.db").display().to_string(),
        )
        .env(
            "LIBRARY_DB",
            rt.data_dir.join("library.db").display().to_string(),
        )
        .env(
            "LT_CONFIG_YAML",
            rt.data_dir.join("config.yaml").display().to_string(),
        )
        .env(
            "LT_PROVIDERS_JSON",
            rt.backend_root.join("providers.json").display().to_string(),
        )
        .env(
            "THUMBNAIL_DIR",
            rt.data_dir.join("thumbnails").display().to_string(),
        );

    let (mut rx, child) = sidecar_cmd.spawn().map_err(|e| e.to_string())?;
    *rt.sidecar.lock().unwrap() = Some(child);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprint!("[backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[backend] terminated {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    let status_url = format!("http://127.0.0.1:{}/api/status", rt.port);
    wait_for_http(&status_url, Duration::from_secs(120)).await?;

    let app_timeout = app.clone();
    let rt_timeout = rt.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(90)).await;
        if *rt_timeout.finished.lock().unwrap() {
            return;
        }
        *rt_timeout.finished.lock().unwrap() = true;
        finish_spike(
            app_timeout,
            rt_timeout,
            serde_json::json!({ "ok": false, "error": "webview/socket smoke timeout (90s)" }),
        )
        .await;
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![spike_port, report_socket_smoke])
        .setup(move |app| {
            let handle = app.handle().clone();

            tauri::async_runtime::block_on(async {
                let backend_root = backend_resources_path(&handle)?;
                let data_dir = tempfile::tempdir()
                    .map_err(|e| e.to_string())?
                    .keep()
                    .map_err(|e| e.to_string())?;
                write_minimal_config(&data_dir)?;
                let port = pick_port()?;

                let rt = Arc::new(SpikeRuntime {
                    port,
                    data_dir: data_dir.clone(),
                    backend_root: backend_root.clone(),
                    sidecar: Mutex::new(None),
                    finished: Mutex::new(false),
                });

                handle.manage(rt.clone());
                spawn_backend_sidecar(&handle, rt).await?;
                Ok::<(), String>(())
            })
            .map_err(|e| e)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(rt) = app_handle.try_state::<Arc<SpikeRuntime>>() {
                    let mut sidecar = rt.sidecar.lock().unwrap();
                    kill_sidecar(&mut *sidecar);
                }
            }
        });
}
