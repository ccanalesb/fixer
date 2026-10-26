use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use url::Url;

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
    app_models_dir: Option<String>,
    port: u16,
    http_status: Value,
    http_probe: Value,
    native_smoke: Value,
    spa_smoke: Value,
    system_one: Value,
    screenshot_path: Option<String>,
    strip_crossorigin: bool,
    sidecar_killed_on_exit: bool,
    ok: bool,
}

struct SpikeRuntime {
    port: u16,
    data_dir: PathBuf,
    backend_root: PathBuf,
    app_models_dir: Option<String>,
    sidecar: Mutex<Option<CommandChild>>,
    sidecar_pid: Mutex<Option<u32>>,
    finished: Mutex<bool>,
    strip_crossorigin: bool,
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

fn strip_crossorigin_enabled() -> bool {
    match std::env::var("SPIKE_STRIP_CROSSORIGIN").ok() {
        None => true,
        Some(v) => matches!(v.as_str(), "1" | "true" | "yes"),
    }
}

fn write_minimal_config(dir: &Path, app_models_dir: Option<&str>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let models_line = app_models_dir
        .map(|d| format!("app_models_dir: {d}\n"))
        .unwrap_or_default();
    std::fs::write(
        dir.join("config.yaml"),
        format!("workers: 1\n{models_line}"),
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

async fn probe_http(port: u16, backend_root: &Path, data_dir: &Path) -> Value {
    let base = format!("http://127.0.0.1:{port}");
    let index_path = backend_root.join("frontend-dist/index.html");
    let index_html = std::fs::read_to_string(&index_path).unwrap_or_default();
    let js_path = index_html
        .split("src=\"")
        .find_map(|s| s.strip_prefix("/assets/").and_then(|r| r.split('"').next()))
        .map(|p| format!("/assets/{p}"))
        .unwrap_or_else(|| "/assets/missing.js".into());
    let css_path = index_html
        .split("href=\"")
        .find_map(|s| s.strip_prefix("/assets/").and_then(|r| r.split('"').next()))
        .map(|p| format!("/assets/{p}"))
        .unwrap_or_else(|| "/assets/missing.css".into());

    async fn one(client: &reqwest::Client, url: String) -> Value {
        match client.get(&url).send().await {
            Ok(res) => {
                let status = res.status().as_u16();
                let ct = res
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let csp = res
                    .headers()
                    .get("content-security-policy")
                    .and_then(|v| v.to_str().ok())
                    .map(String::from);
                let body = res.bytes().await.unwrap_or_default();
                let head = String::from_utf8_lossy(&body[..body.len().min(120)]).to_string();
                let looks_like_html = head.trim_start().starts_with("<!")
                    || head.to_ascii_lowercase().contains("<html");
                json!({
                    "url": url,
                    "status": status,
                    "contentType": ct,
                    "bytes": body.len(),
                    "looksLikeHtml": looks_like_html,
                    "headSample": &head[..head.len().min(80)],
                    "csp": csp,
                })
            }
            Err(e) => json!({ "url": url, "error": e.to_string() }),
        }
    }

    let client = reqwest::Client::new();
    let requests = vec![
        one(&client, format!("{base}/")).await,
        one(&client, format!("{base}{js_path}")).await,
        one(&client, format!("{base}{css_path}")).await,
        one(&client, format!("{base}/assets/nonexistent-spike-probe.js")).await,
        one(&client, format!("{base}/images")).await,
    ];

    let probe = json!({
        "base": base,
        "indexHasCrossoriginAttr": index_html.contains("crossorigin"),
        "requests": requests,
    });

    let out = data_dir.join("spike-http-probe.json");
    let _ = std::fs::write(&out, serde_json::to_string_pretty(&probe).unwrap());
    probe
}

async fn capture_screenshot(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    tokio::time::sleep(Duration::from_millis(800)).await;
    let p = path.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("screencapture")
                .args(["-x", &p])
                .status();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("import")
                .args(["-window", "root", &p])
                .status();
        }
        #[cfg(target_os = "windows")]
        {
            let ps = format!(
                r#"Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('{p}');"#
            );
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &ps])
                .status();
        }
    })
    .await
    .ok();
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
async fn pick_catalog_path(app: AppHandle) -> Result<String, String> {
    if std::env::var("SPIKE_DIALOG_STUB")
        .ok()
        .as_deref()
        == Some("1")
    {
        return Ok("/tmp/spike-stub-catalog.lrcat".into());
    }

    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("Lightroom catalog", &["lrcat"])
        .blocking_pick_file();

    match path {
        Some(p) => Ok(p.to_string()),
        None => Err("dialog dismissed".into()),
    }
}

#[tauri::command]
async fn report_spa_smoke(
    app: AppHandle,
    state: State<'_, Arc<SpikeRuntime>>,
    payload: Value,
) -> Result<(), String> {
    if *state.finished.lock().unwrap() {
        return Ok(());
    }
    *state.finished.lock().unwrap() = true;

    let shot = std::env::var("SPIKE_SCREENSHOT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| state.data_dir.join("spike-window.png"));
    capture_screenshot(&shot).await;

    let mut payload = payload;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "screenshotPath".into(),
            json!(shot.display().to_string()),
        );
    }

    finish_spike(app, state.inner().clone(), payload).await;
    Ok(())
}

async fn run_systemone_via_sidecar(app: &AppHandle, rt: &SpikeRuntime) -> Value {
    let models_dir = match rt.app_models_dir.as_deref() {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => {
            return json!({
                "ok": false,
                "error": "SPIKE_APP_MODELS_DIR not set"
            });
        }
    };

    let out_path = rt.data_dir.join("systemone-smoke.json");
    let port_s = rt.port.to_string();
    let pid_s = rt
        .sidecar_pid
        .lock()
        .unwrap()
        .map(|p| p.to_string())
        .unwrap_or_default();

    let sidecar = match app.shell().sidecar("node") {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "ok": false,
                "error": format!("sidecar node unavailable: {e}")
            });
        }
    };

    let (mut rx, child) = match sidecar
        .args(["run-systemone-smoke.mjs"])
        .current_dir(&rt.backend_root)
        .env("SPIKE_PORT", &port_s)
        .env("SPIKE_BACKEND_ROOT", rt.backend_root.display().to_string())
        .env("SPIKE_APP_MODELS_DIR", &models_dir)
        .env("SPIKE_SYSTEMONE_JSON", out_path.display().to_string())
        .env("SPIKE_BACKEND_PID", &pid_s)
        .spawn()
    {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "ok": false,
                "error": format!("systemone sidecar spawn failed: {e}")
            });
        }
    };

    let mut exit_code: Option<i32> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while std::time::Instant::now() < deadline {
        if let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprint!("[systemone] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    exit_code = payload.code;
                    break;
                }
                _ => {}
            }
        } else {
            break;
        }
    }
    let _ = child.kill();

    if out_path.is_file() {
        std::fs::read_to_string(&out_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| {
                json!({
                    "ok": false,
                    "error": "invalid systemone-smoke.json",
                    "exit_code": exit_code,
                })
            })
    } else {
        json!({
            "ok": false,
            "error": "systemone smoke produced no JSON",
            "exit_code": exit_code,
        })
    }
}

async fn finish_spike(app: AppHandle, rt: Arc<SpikeRuntime>, spa_smoke: Value) {
    let status_url = format!("http://127.0.0.1:{}/api/status", rt.port);
    let http_status = wait_for_http(&status_url, Duration::from_secs(10))
        .await
        .unwrap_or(Value::String("unavailable".into()));

    let http_probe: Value = std::fs::read_to_string(rt.data_dir.join("spike-http-probe.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!("missing spike-http-probe.json"));

    let result_path = rt.data_dir.join("spike-result.json");
    let native_smoke: Value = std::fs::read_to_string(&result_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::String("missing spike-result.json".into()));

    let system_one = run_systemone_via_sidecar(&app, &rt).await;

    let native_ok = native_smoke
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let spa_ok = spa_smoke.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let system_ok = system_one.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let http_ok = http_status.get("status").and_then(|v| v.as_str()) == Some("ok");

    let webview_user_agent = spa_smoke
        .get("userAgent")
        .and_then(|v| v.as_str())
        .map(String::from);

    let screenshot_path = spa_smoke
        .get("screenshotPath")
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
        app_models_dir: rt.app_models_dir.clone(),
        port: rt.port,
        http_status,
        http_probe,
        native_smoke,
        spa_smoke: spa_smoke.clone(),
        system_one,
        screenshot_path,
        strip_crossorigin: rt.strip_crossorigin,
        sidecar_killed_on_exit: true,
        ok: http_ok && native_ok && spa_ok && system_ok,
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

async fn navigate_to_loopback(app: &AppHandle, port: u16) {
    let url = format!("http://127.0.0.1:{port}/");
    let Some(win) = app.get_webview_window("main") else {
        eprintln!("navigate: main window missing");
        return;
    };
    if let Err(e) = win.navigate(Url::parse(&url).expect("valid loopback url")) {
        eprintln!("navigate failed: {e}");
    }
}

async fn spawn_backend_sidecar(app: &AppHandle, rt: Arc<SpikeRuntime>) -> Result<(), String> {
    let entry = rt.backend_root.join("spike-entry.mjs");
    if !entry.is_file() {
        return Err(format!("missing {}", entry.display()));
    }

    let port_s = rt.port.to_string();
    let frontend_dist = rt.backend_root.join("frontend-dist");
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
            "SPIKE_FRONTEND_DIST",
            frontend_dist.display().to_string(),
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
    *rt.sidecar_pid.lock().unwrap() = Some(child.pid());
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
    wait_for_http(&status_url, Duration::from_secs(180)).await?;

    let probe = probe_http(rt.port, &rt.backend_root, &rt.data_dir).await;
    eprintln!("SPIKE_HTTP_PROBE={}", serde_json::to_string(&probe).unwrap_or_default());

    navigate_to_loopback(app, rt.port).await;

    let app_timeout = app.clone();
    let rt_timeout = rt.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(240)).await;
        if *rt_timeout.finished.lock().unwrap() {
            return;
        }
        *rt_timeout.finished.lock().unwrap() = true;
        finish_spike(
            app_timeout,
            rt_timeout,
            json!({ "ok": false, "error": "spa smoke timeout (240s)" }),
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            spike_port,
            pick_catalog_path,
            report_spa_smoke
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let init_script = include_str!("../../spike-init-script.js");

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("LT Tauri Real SPA Spike")
            .inner_size(1280.0, 800.0)
            .initialization_script(init_script)
            .visible(true)
            .build()
            .map_err(|e| e.to_string())?;

            tauri::async_runtime::block_on(async {
                let backend_root = backend_resources_path(&handle)?;
                let app_models_dir = std::env::var("SPIKE_APP_MODELS_DIR")
                    .ok()
                    .filter(|s| !s.trim().is_empty());
                let data_dir = tempfile::tempdir()
                    .map_err(|e| e.to_string())?
                    .keep();
                write_minimal_config(&data_dir, app_models_dir.as_deref())?;
                let port = pick_port()?;
                let strip_crossorigin = strip_crossorigin_enabled();

                let rt = Arc::new(SpikeRuntime {
                    port,
                    data_dir: data_dir.clone(),
                    backend_root: backend_root.clone(),
                    app_models_dir,
                    sidecar: Mutex::new(None),
                    sidecar_pid: Mutex::new(None),
                    finished: Mutex::new(false),
                    strip_crossorigin,
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
