/**
 * Ensure Node core is running; used by the Tauri desktop shell.
 */
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

static CORE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("BRAIN_DATA_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("second-brain");
    }
    PathBuf::from("second-brain")
}

fn port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000)
}

pub fn core_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// Read per-install API token written by the Node core.
pub fn api_token() -> Option<String> {
    let path = data_dir().join("api-token");
    let raw = fs::read_to_string(path).ok()?;
    let t = raw.trim().to_string();
    if t.len() >= 32 {
        Some(t)
    } else {
        None
    }
}

fn auth_headers() -> String {
    match api_token() {
        Some(t) => format!("Authorization: Bearer {t}\r\nX-Brain-Token: {t}\r\n"),
        None => String::new(),
    }
}

pub fn health_ok() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{}", port());
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:3000".parse().unwrap()),
        Duration::from_millis(400),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{}Connection: close\r\n\r\n",
        port(),
        auth_headers()
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.contains("200") && buf.contains("\"ok\":true")
}

/// Current desktop expects these API capabilities (bump with worker health.apiVersion).
const REQUIRED_API_VERSION: i32 = 7;

pub fn core_api_version() -> Option<i32> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{}", port());
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:3000".parse().unwrap()),
        Duration::from_millis(400),
    ) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{}Connection: close\r\n\r\n",
        port(),
        auth_headers()
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return None;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    let key = "\"apiVersion\":";
    let idx = buf.find(key)?;
    let rest = &buf[idx + key.len()..];
    let digits: String = rest
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

pub fn core_is_current() -> bool {
    core_api_version().unwrap_or(0) >= REQUIRED_API_VERSION
}

fn repo_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("BRAIN_REPO_ROOT") {
        let pb = PathBuf::from(p);
        if pb.join("package.json").exists() {
            return Some(pb);
        }
    }

    // Prefer walk from the desktop .exe location (works when double-clicked)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(mut cur) = exe.parent().map(|p| p.to_path_buf()) {
            for _ in 0..12 {
                if cur.join("package.json").exists()
                    && cur.join("packages").join("worker").exists()
                {
                    return Some(cur);
                }
                if !cur.pop() {
                    break;
                }
            }
        }
    }

    // Walk up from cwd
    if let Ok(mut cur) = std::env::current_dir() {
        for _ in 0..8 {
            if cur.join("package.json").exists()
                && cur.join("packages").join("worker").exists()
            {
                return Some(cur);
            }
            if !cur.pop() {
                break;
            }
        }
    }

    None
}

fn find_node() -> Option<PathBuf> {
    // where node
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("where").arg("node").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                let first = s.lines().next()?.trim();
                if !first.is_empty() {
                    return Some(PathBuf::from(first));
                }
            }
        }
        let pf = std::env::var("ProgramFiles").ok()?;
        let p = PathBuf::from(pf).join("nodejs").join("node.exe");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn ensure_core_running() -> Result<(), String> {
    if health_ok() && core_is_current() {
        return Ok(());
    }
    // Stale core on :3000 (missing spam/wake APIs) — recycle it
    if health_ok() && !core_is_current() {
        stop_core_if_owned();
        thread::sleep(Duration::from_millis(600));
    }

    let root = repo_root().ok_or_else(|| {
        "Could not find second-brain repo (set BRAIN_REPO_ROOT)".to_string()
    })?;
    let node = find_node().ok_or_else(|| "node.exe not found on PATH".to_string())?;
    let tsx = root.join("node_modules").join("tsx").join("dist").join("cli.mjs");
    let alt = root.join("node_modules").join("tsx").join("dist").join("cli.js");
    let tsx_cli = if tsx.exists() {
        tsx
    } else if alt.exists() {
        alt
    } else {
        return Err("tsx not installed — run npm install in the repo".into());
    };
    let cli = root
        .join("packages")
        .join("worker")
        .join("src")
        .join("cli.ts");

    let _ = fs::create_dir_all(data_dir());
    let core_log = data_dir().join("core.log");
    let core_err = data_dir().join("core.err.log");
    let out_file = fs::File::create(&core_log).ok();
    let err_file = fs::File::create(&core_err).ok();

    let mut cmd = Command::new(node);
    cmd.arg(tsx_cli)
        .arg(cli)
        .arg("daemon")
        .current_dir(&root)
        .stdin(Stdio::null());
    if let Some(f) = out_file {
        cmd.stdout(Stdio::from(f));
    } else {
        cmd.stdout(Stdio::null());
    }
    if let Some(f) = err_file {
        cmd.stderr(Stdio::from(f));
    } else {
        cmd.stderr(Stdio::null());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn core: {e}"))?;

    {
        let mut slot = CORE_CHILD.lock().map_err(|e| e.to_string())?;
        *slot = Some(child);
    }

    // wait up to ~120s for health — the desktop UI is not blocked on this (it
    // shows a loading screen), so give a cold tsx compile generous headroom.
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if health_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(350));
    }
    Err(format!(
        "core did not become healthy at {} within timeout (see {})",
        core_url(),
        core_err.display()
    ))
}

pub fn stop_core_if_owned() {
    if let Ok(mut slot) = CORE_CHILD.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // Also clear whatever is still bound to the core port so Quit is a real stop
    // (covers cores left from an earlier launch / attach-to-healthy path).
    stop_core_on_port(port());
}

fn stop_core_on_port(p: u16) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "$conns = Get-NetTCPConnection -LocalPort {p} -State Listen -ErrorAction SilentlyContinue; \
                     foreach ($c in $conns) {{ Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }}"
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = p;
    }
}

#[allow(dead_code)]
pub fn is_path_file(p: &Path) -> bool {
    p.is_file()
}
