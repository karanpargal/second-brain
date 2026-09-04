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

/// Shared data directory — must match `packages/core` `defaultDataDir()`.
pub fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("BRAIN_DATA_DIR") {
        return PathBuf::from(p);
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("second-brain");
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            return PathBuf::from(home)
                .join("AppData")
                .join("Local")
                .join("second-brain");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("second-brain");
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("second-brain");
        }
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
const REQUIRED_API_VERSION: i32 = 14;

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

    // Prefer walk from the desktop binary location (works when double-clicked)
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

/// Node majors the core's native modules load under. better-sqlite3 11.x needs
/// V8 APIs that Node 26 removed, so a newer Node is worse than useless here:
/// the daemon starts and then dies on the better_sqlite3.node ABI check.
const MIN_NODE_MAJOR: u32 = 22;
const MAX_NODE_MAJOR: u32 = 25;

fn node_major(bin: &Path) -> Option<u32> {
    let out = Command::new(bin).arg("-v").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// A Node that exists *and* reports a major version the core can run on.
fn usable_node(bin: &Path) -> bool {
    bin.exists()
        && node_major(bin)
            .map(|m| (MIN_NODE_MAJOR..=MAX_NODE_MAJOR).contains(&m))
            .unwrap_or(false)
}

/// Explicit pin, for machines whose default Node is out of range.
/// GUI apps do not inherit shell PATH or env, so the data-dir file is the
/// reliable channel; the env var is there for `npm run` / dev shells.
fn pinned_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("BRAIN_NODE_BIN") {
        let pb = PathBuf::from(p.trim());
        if usable_node(&pb) {
            return Some(pb);
        }
    }
    let raw = fs::read_to_string(data_dir().join("node-path")).ok()?;
    let pb = PathBuf::from(raw.trim());
    if usable_node(&pb) {
        Some(pb)
    } else {
        None
    }
}

/// Version directories under a version-manager root, newest first.
/// Sorted numerically, so v9 does not outrank v10 the way a string sort would.
#[cfg(target_os = "macos")]
fn newest_first(root: &Path) -> Vec<PathBuf> {
    let mut versions: Vec<(Vec<u32>, PathBuf)> = match fs::read_dir(root) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .map(|p| {
                let parts = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .trim_start_matches('v')
                    .split('.')
                    .map(|s| s.parse().unwrap_or(0))
                    .collect();
                (parts, p)
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p).collect()
}

fn find_node() -> Option<PathBuf> {
    if let Some(p) = pinned_node() {
        return Some(p);
    }

    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("where").arg("node").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Some(p) = s
                    .lines()
                    .map(|l| PathBuf::from(l.trim()))
                    .find(|p| usable_node(p))
                {
                    return Some(p);
                }
            }
        }
        let pf = std::env::var("ProgramFiles").ok()?;
        let p = PathBuf::from(pf).join("nodejs").join("node.exe");
        if usable_node(&p) {
            return Some(p);
        }
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        // GUI apps do not inherit shell PATH — probe known install locations.
        // Every candidate is version-checked: the newest Node on the machine is
        // often too new for the core's native modules, so "first that exists"
        // is the wrong pick. Managed installs are walked newest-first.
        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ];
        if !home.is_empty() {
            candidates.push(PathBuf::from(&home).join(".volta").join("bin").join("node"));

            // nvm installs, newest first
            let nvm_dir = PathBuf::from(&home).join(".nvm").join("versions").join("node");
            candidates.extend(newest_first(&nvm_dir).into_iter().map(|v| v.join("bin").join("node")));

            // fnm (default multi-arch layout)
            let fnm_root = PathBuf::from(&home).join(".local").join("share").join("fnm");
            candidates.push(fnm_root.join("aliases").join("default").join("bin").join("node"));
            candidates.push(fnm_root.join("current").join("bin").join("node"));
            candidates.extend(
                newest_first(&fnm_root.join("node-versions"))
                    .into_iter()
                    .map(|v| v.join("installation").join("bin").join("node")),
            );
        }
        if let Some(p) = candidates.into_iter().find(|p| usable_node(p)) {
            return Some(p);
        }
        // Last resort: login shell PATH (zsh is default on modern macOS)
        if let Ok(out) = Command::new("zsh")
            .args(["-ilc", "command -v node"])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                let first = s.lines().next().unwrap_or("").trim();
                if !first.is_empty() {
                    let p = PathBuf::from(first);
                    if usable_node(&p) {
                        return Some(p);
                    }
                }
            }
        }
        if let Ok(out) = Command::new("which").arg("node").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                let first = s.lines().next().unwrap_or("").trim();
                if !first.is_empty() {
                    let p = PathBuf::from(first);
                    if usable_node(&p) {
                        return Some(p);
                    }
                }
            }
        }
        return None;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(out) = Command::new("which").arg("node").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                let first = s.lines().next()?.trim();
                if !first.is_empty() {
                    return Some(PathBuf::from(first));
                }
            }
        }
        None
    }
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
    let node = find_node().ok_or_else(|| {
        format!(
            "No usable Node.js found — need major {}-{} (Homebrew/nvm/volta/fnm). \
             Pin one by writing its path to {}/node-path or setting BRAIN_NODE_BIN.",
            MIN_NODE_MAJOR,
            MAX_NODE_MAJOR,
            data_dir().display()
        )
    })?;
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
    #[cfg(unix)]
    {
        if let Ok(out) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{p}")])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                for line in s.lines() {
                    let pid = line.trim();
                    if pid.is_empty() {
                        continue;
                    }
                    let _ = Command::new("kill")
                        .args(["-9", pid])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }
}

#[allow(dead_code)]
pub fn is_path_file(p: &Path) -> bool {
    p.is_file()
}
