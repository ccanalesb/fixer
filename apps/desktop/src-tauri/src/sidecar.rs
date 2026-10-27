use crate::log_rotate::RotatingLog;
use crate::port::app_port;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;

pub struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
}

impl SidecarHandle {
    pub fn spawn(
        app: &AppHandle,
        resources_dir: &Path,
        data_dir: &Path,
        log_dir: &Path,
    ) -> std::io::Result<Arc<Self>> {
        fs_create_dir(data_dir)?;
        let node = node_binary_path(app)?;
        let server_js = resources_dir.join("dist/src/server.js");
        if !server_js.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("missing backend entry {}", server_js.display()),
            ));
        }

        let port = app_port();
        let mut cmd = Command::new(&node);
        cmd.arg(&server_js)
            .current_dir(resources_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("LT_DATA_DIR", data_dir)
            .env("LT_RESOURCES_DIR", resources_dir)
            .env("FLASK_HOST", "127.0.0.1")
            .env("FLASK_PORT", port.to_string())
            .env("FLASK_DEBUG", "false")
            .env("LT_EXIT_ON_STDIN_EOF", "1")
            .env(
                "FRONTEND_URL",
                format!("http://127.0.0.1:{port}"),
            );

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(windows_job::CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()?;
        #[cfg(windows)]
        unsafe {
            windows_job::assign_kill_on_job_close(&child)?;
        }

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let log = Arc::new(Mutex::new(RotatingLog::open(log_dir, "backend.log")?));
        spawn_log_pipe(stdout, Arc::clone(&log));
        spawn_log_pipe(stderr, log);

        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
        }))
    }

    pub fn shutdown(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            *stdin = None;
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.as_mut() {
                let _ = child.wait_timeout(Duration::from_secs(10));
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                #[cfg(unix)]
                {
                    use nix::sys::signal::{killpg, Signal};
                    use nix::unistd::Pid;
                    let pgid = Pid::from_raw(-(child.id() as i32));
                    let _ = killpg(pgid, Signal::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
    }
}

fn fs_create_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

fn node_binary_path(_app: &AppHandle) -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent for current exe"))?;

    #[cfg(windows)]
    let candidates = ["node.exe", "node-x86_64-pc-windows-msvc.exe"];
    #[cfg(not(windows))]
    let candidates = [
        "node",
        "node-aarch64-apple-darwin",
        "node-x86_64-apple-darwin",
        "node-x86_64-unknown-linux-gnu",
    ];

    for name in candidates {
        let path = dir.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("node sidecar binary not found next to {}", exe.display()),
    ))
}

fn spawn_log_pipe(
    reader: Option<impl Read + Send + 'static>,
    log: Arc<Mutex<RotatingLog>>,
) {
    if let Some(mut reader) = reader {
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                            let line = pending.drain(..=pos).collect::<Vec<_>>();
                            let line = &line[..line.len().saturating_sub(1)];
                            if let Ok(mut log) = log.lock() {
                                let _ = log.write_line(line);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                if let Ok(mut log) = log.lock() {
                    let _ = log.write_line(&pending);
                }
            }
        });
    }
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::mem;
    use std::process::Child;
    use std::ptr;

    pub const CREATE_NO_WINDOW: u32 = 0x08000000;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(a: *mut std::ffi::c_void, b: *const u16) -> *mut std::ffi::c_void;
        fn SetInformationJobObject(
            job: *mut std::ffi::c_void,
            class: u32,
            info: *mut std::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void)
            -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    pub unsafe fn assign_kill_on_job_close(child: &Child) -> io::Result<()> {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut info: JobObjectExtendedLimitInformation = mem::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut _,
            mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }

        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
        if process.is_null() {
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }
        if AssignProcessToJobObject(job, process) == 0 {
            CloseHandle(process);
            CloseHandle(job);
            return Err(io::Error::last_os_error());
        }
        CloseHandle(process);
        mem::forget(job);
        Ok(())
    }
}

trait WaitTimeout {
    fn wait_timeout(&mut self, dur: Duration) -> std::io::Result<std::process::ExitStatus>;
}

impl WaitTimeout for Child {
    fn wait_timeout(&mut self, dur: Duration) -> std::io::Result<std::process::ExitStatus> {
        let start = std::time::Instant::now();
        loop {
            if let Ok(Some(status)) = self.try_wait() {
                return Ok(status);
            }
            if start.elapsed() >= dur {
                return self.wait();
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}
