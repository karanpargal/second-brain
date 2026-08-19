//! Ambient capture: foreground window + browser history + OCR → JSONL spool.
use chrono::{DateTime, Local, Utc};
use directories::BaseDirs;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[derive(Clone, Serialize)]
pub struct CaptureStatus {
    pub capturing: bool,
    pub paused_until: Option<String>,
    pub last_obs: Option<String>,
    pub spool_dir: String,
}

struct Shared {
    paused_until: Option<DateTime<Utc>>,
    last_obs: Option<String>,
    last_title: String,
    last_exe: String,
    last_change: std::time::Instant,
    last_ocr_phash: u64,
    last_ocr_at: std::time::Instant,
    last_ocr_text_hash: u64,
    last_ocr_focus_key: String,
    /// Last non-widget foreground app (widget is always-on-top and steals focus)
    last_user_title: String,
    last_user_exe: String,
    last_user_app: String,
    last_user_pid: u32,
    last_wake_at: std::time::Instant,
    browser_cursor: i64,
    block_exes: HashSet<String>,
    block_domains: HashSet<String>,
}

pub struct CaptureEngine {
    running: AtomicBool,
    shared: Arc<Mutex<Shared>>,
    data_dir: PathBuf,
    spool_dir: PathBuf,
}

impl CaptureEngine {
    pub fn new() -> Self {
        let data_dir = default_data_dir();
        let spool_dir = data_dir.join("spool");
        let _ = fs::create_dir_all(&spool_dir);
        let mut block_exes = HashSet::new();
        for e in [
            "1password.exe",
            "1password for windows desktop.exe",
            "bitwarden.exe",
            "keepass.exe",
            "keepassxc.exe",
            "lastpass.exe",
            "credentialuibroker.exe",
            "windowshellofaceserver.exe",
        ] {
            block_exes.insert(e.to_string());
        }
        let mut block_domains = HashSet::new();
        for d in [
            "accounts.google.com",
            "login.microsoftonline.com",
            "login.live.com",
            "auth0.com",
            "id.apple.com",
            "paypal.com",
        ] {
            block_domains.insert(d.to_string());
        }
        load_control_into(&data_dir, &mut block_exes, &mut block_domains);

        Self {
            running: AtomicBool::new(false),
            shared: Arc::new(Mutex::new(Shared {
                paused_until: None,
                last_obs: None,
                last_title: String::new(),
                last_exe: String::new(),
                last_change: std::time::Instant::now(),
                last_ocr_phash: 0,
                last_ocr_at: std::time::Instant::now() - Duration::from_secs(60),
                last_ocr_text_hash: 0,
                last_ocr_focus_key: String::new(),
                last_user_title: String::new(),
                last_user_exe: String::new(),
                last_user_app: String::new(),
                last_user_pid: 0,
                last_wake_at: std::time::Instant::now() - Duration::from_secs(60),
                browser_cursor: 0,
                block_exes,
                block_domains,
            })),
            data_dir,
            spool_dir,
        }
    }

    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let eng = Arc::clone(self);
        thread::spawn(move || eng.loop_forever());
    }

    pub fn pause_for_minutes(&self, minutes: u64) {
        let until = Utc::now() + chrono::Duration::minutes(minutes as i64);
        {
            let mut s = self.shared.lock();
            s.paused_until = Some(until);
        }
        write_control(&self.data_dir, Some(until.to_rfc3339()), false);
    }

    pub fn resume(&self) {
        {
            let mut s = self.shared.lock();
            s.paused_until = None;
        }
        write_control(&self.data_dir, None, true);
    }

    pub fn status(&self) -> CaptureStatus {
        let control_pause = read_paused_until(&self.data_dir);
        let s = self.shared.lock();
        CaptureStatus {
            capturing: self.running.load(Ordering::SeqCst)
                && !is_paused(&s, control_pause.as_ref()),
            paused_until: s
                .paused_until
                .map(|t| t.to_rfc3339())
                .or(control_pause),
            last_obs: s.last_obs.clone(),
            spool_dir: self.spool_dir.display().to_string(),
        }
    }

    fn loop_forever(&self) {
        let idle_limit_secs = 120u32;
        let mut last_browser = std::time::Instant::now() - Duration::from_secs(60);
        let mut last_hb = std::time::Instant::now() - Duration::from_secs(60);
        ocr_debug("capture thread started");
        loop {
            if !self.running.load(Ordering::SeqCst) {
                break;
            }
            let control_pause = read_paused_until(&self.data_dir);
            {
                let mut s = self.shared.lock();
                if let Some(ref p) = control_pause {
                    if let Ok(dt) = DateTime::parse_from_rfc3339(p) {
                        s.paused_until = Some(dt.with_timezone(&Utc));
                    }
                }
            }

            let paused = {
                let s = self.shared.lock();
                is_paused(&s, control_pause.as_ref())
            };
            if paused {
                thread::sleep(Duration::from_secs(2));
                continue;
            }

            if idle_seconds() > idle_limit_secs {
                let slow_ok = {
                    let s = self.shared.lock();
                    s.last_ocr_at.elapsed() > Duration::from_secs(45)
                };
                if !slow_ok {
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
            }

            let toggles = read_toggles(&self.data_dir);
            if toggles.window {
                self.tick_window();
            }

            if toggles.browser && last_browser.elapsed() > Duration::from_secs(30) {
                self.tick_browser();
                last_browser = std::time::Instant::now();
            }

            if toggles.ocr {
                self.tick_ocr();
            }
            if last_hb.elapsed() > Duration::from_secs(30) {
                last_hb = std::time::Instant::now();
                ocr_debug("capture heartbeat");
            }
            thread::sleep(Duration::from_secs(1));
        }
    }

    fn tick_window(&self) {
        let Some((title, exe, app)) = foreground_window_info() else {
            return;
        };
        let exe_l = exe.to_lowercase();
        // Remember the real app under the floating widget
        if !exe_l.contains("second-brain") {
            let pid = foreground_pid().unwrap_or(0);
            let mut s = self.shared.lock();
            s.last_user_title = title.clone();
            s.last_user_exe = exe.clone();
            s.last_user_app = app.clone();
            s.last_user_pid = pid;
        }
        {
            let s = self.shared.lock();
            if s.block_exes.iter().any(|b| exe_l.contains(b)) {
                return;
            }
            let tl = title.to_lowercase();
            if tl.contains("incognito") || tl.contains("inprivate") {
                return;
            }
        }

        let mut emit = false;
        let mut dwell_ms = 0u64;
        {
            let mut s = self.shared.lock();
            if title != s.last_title || exe != s.last_exe {
                dwell_ms = s.last_change.elapsed().as_millis() as u64;
                s.last_title = title.clone();
                s.last_exe = exe.clone();
                s.last_change = std::time::Instant::now();
                emit = true;
            }
        }
        if emit && !exe_l.contains("second-brain") {
            let chat = is_chat_surface(&app, &exe, &title);
            self.append_obs(json!({
                "ts": Utc::now().to_rfc3339(),
                "source": "window",
                "app": app,
                "exe": exe,
                "window_title": title,
                "dwell_ms": dwell_ms,
                "redacted": false,
                "chat": chat
            }));
            if chat {
                self.wake_core_loops();
            }
        }
    }

    fn tick_browser(&self) {
        for (browser, hist) in browser_history_paths() {
            if !hist.exists() {
                continue;
            }
            let tmp = std::env::temp_dir().join(format!("sb-hist-{browser}.db"));
            if fs::copy(&hist, &tmp).is_err() {
                continue;
            }
            let cursor = self.shared.lock().browser_cursor;
            if let Ok(conn) = Connection::open(&tmp) {
                let mut max_visit = cursor;
                let q = "SELECT urls.url, urls.title, visits.visit_time
                         FROM visits
                         JOIN urls ON urls.id = visits.url
                         WHERE visits.visit_time > ?
                         ORDER BY visits.visit_time ASC
                         LIMIT 200";
                if let Ok(mut stmt) = conn.prepare(q) {
                    if let Ok(rows) = stmt.query_map([cursor], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1).unwrap_or_default(),
                            row.get::<_, i64>(2)?,
                        ))
                    }) {
                        for row in rows.flatten() {
                            let (url, title, vt) = row;
                            if vt > max_visit {
                                max_visit = vt;
                            }
                            let domain = url_domain(&url);
                            let blocked = {
                                let s = self.shared.lock();
                                domain
                                    .as_ref()
                                    .map(|d| s.block_domains.iter().any(|b| d.contains(b)))
                                    .unwrap_or(false)
                            };
                            if blocked {
                                continue;
                            }
                            let chat = is_chat_surface(browser, "", &title)
                                || is_chat_url(&url);
                            self.append_obs(json!({
                                "ts": chrome_time_to_rfc3339(vt),
                                "source": "browser",
                                "app": browser,
                                "window_title": title,
                                "url": url,
                                "domain": domain,
                                "dwell_ms": 0,
                                "redacted": false,
                                "chat": chat
                            }));
                        }
                    }
                }
                if max_visit > cursor {
                    self.shared.lock().browser_cursor = max_visit;
                }
            }
            let _ = fs::remove_file(&tmp);
        }
    }

    fn tick_ocr(&self) {
        #[cfg(windows)]
        {
            let Some((fg_title, fg_exe, fg_app)) = foreground_window_info() else {
                return;
            };
            // Widget is always-on-top — OCR the last real app underneath it
            let (title, exe, app, target_pid) = {
                let mut s = self.shared.lock();
                if fg_exe.to_lowercase().contains("second-brain") {
                    if s.last_user_exe.is_empty() {
                        return;
                    }
                    (
                        s.last_user_title.clone(),
                        s.last_user_exe.clone(),
                        s.last_user_app.clone(),
                        s.last_user_pid,
                    )
                } else {
                    let pid = foreground_pid().unwrap_or(0);
                    s.last_user_title = fg_title.clone();
                    s.last_user_exe = fg_exe.clone();
                    s.last_user_app = fg_app.clone();
                    s.last_user_pid = pid;
                    (fg_title, fg_exe, fg_app, pid)
                }
            };
            let chat = is_chat_surface(&app, &exe, &title);
            let skip_desk = is_skip_ocr_desk(&app, &exe, &title, "");
            let exe_l = exe.to_lowercase();
            let title_l = title.to_lowercase();
            let focus_key = format!("{exe}|{title}");
            if skip_desk || title_l.contains("incognito") || title_l.contains("inprivate")
            {
                let mut s = self.shared.lock();
                s.last_ocr_at = std::time::Instant::now();
                s.last_ocr_focus_key = focus_key;
                return;
            }
            let interval = Duration::from_secs(if chat { 5 } else { 8 });
            let should = {
                let s = self.shared.lock();
                s.last_ocr_at.elapsed() > interval
            };
            if !should {
                return;
            }

            {
                let mut s = self.shared.lock();
                if s.block_exes.iter().any(|b| exe_l.contains(b)) {
                    s.last_ocr_at = std::time::Instant::now();
                    s.last_ocr_focus_key = focus_key;
                    return;
                }
                if s.block_domains.iter().any(|b| title_l.contains(b)) {
                    s.last_ocr_at = std::time::Instant::now();
                    s.last_ocr_focus_key = focus_key;
                    return;
                }
            }

            if let Some((text, phash, windowed)) = capture_target_ocr(target_pid, &title, chat) {
                let text = {
                    let s = self.shared.lock();
                    filter_blocked_ocr_text(&text, &s.block_domains)
                };
                let skip = {
                    let s = self.shared.lock();
                    s.last_ocr_phash != 0 && hamming(s.last_ocr_phash, phash) < 6
                };
                {
                    let mut s = self.shared.lock();
                    s.last_ocr_at = std::time::Instant::now();
                    s.last_ocr_phash = phash;
                    s.last_ocr_text_hash = fnv1a_64(text.as_bytes());
                    s.last_ocr_focus_key = focus_key;
                }
                if skip || text.trim().len() < 8 {
                    return;
                }
                let clipped: String = text.chars().take(8_000).collect();
                self.append_obs(json!({
                    "ts": Utc::now().to_rfc3339(),
                    "source": "ocr",
                    "app": app,
                    "exe": exe,
                    "window_title": title,
                    "text": clipped,
                    "dwell_ms": 0,
                    "redacted": false,
                    "chat": chat,
                    "fullscreen": !windowed,
                    "window_ocr": windowed
                }));
                if chat {
                    self.wake_core_loops();
                }
            } else {
                let mut s = self.shared.lock();
                s.last_ocr_at = std::time::Instant::now();
                s.last_ocr_focus_key = focus_key;
            }
        }
    }

    fn append_obs(&self, value: serde_json::Value) {
        let day = Local::now().format("%Y-%m-%d");
        let path = self.spool_dir.join(format!("obs-{day}.jsonl"));
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{value}");
            let mut s = self.shared.lock();
            s.last_obs = Some(Utc::now().to_rfc3339());
        }
    }

    /// Ask local core to ingest spool + detect loops ASAP (debounced).
    fn wake_core_loops(&self) {
        {
            let mut s = self.shared.lock();
            if s.last_wake_at.elapsed() < Duration::from_secs(6) {
                return;
            }
            s.last_wake_at = std::time::Instant::now();
        }
        thread::spawn(|| {
            use std::io::{Read, Write};
            use std::net::TcpStream;
            let Ok(mut stream) = TcpStream::connect_timeout(
                &"127.0.0.1:3000".parse().unwrap(),
                Duration::from_millis(400),
            ) else {
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
            let auth = crate::core::api_token()
                .map(|t| format!("Authorization: Bearer {t}\r\nX-Brain-Token: {t}\r\n"))
                .unwrap_or_default();
            let req = format!(
                "POST /api/capture/wake HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(req.as_bytes()).is_err() {
                return;
            }
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf);
        });
    }
}

fn default_data_dir() -> PathBuf {
    if let Some(base) = BaseDirs::new() {
        return base.data_local_dir().join("second-brain");
    }
    PathBuf::from("second-brain")
}

fn is_paused(s: &Shared, control: Option<&String>) -> bool {
    if let Some(until) = s.paused_until {
        if until > Utc::now() {
            return true;
        }
    }
    if let Some(p) = control {
        if let Ok(dt) = DateTime::parse_from_rfc3339(p) {
            if dt.with_timezone(&Utc) > Utc::now() {
                return true;
            }
        }
    }
    false
}

fn write_control(data_dir: &Path, paused_until: Option<String>, clear: bool) {
    let path = data_dir.join("capture-control.json");
    let mut map = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    if clear {
        if let Some(o) = map.as_object_mut() {
            o.remove("paused_until");
        }
    }
    if let Some(p) = paused_until {
        map["paused_until"] = json!(p);
    }
    let _ = fs::write(path, map.to_string());
}

fn read_paused_until(data_dir: &Path) -> Option<String> {
    let path = data_dir.join("capture-control.json");
    let text = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("paused_until")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

#[derive(Clone, Copy)]
struct CaptureToggles {
    window: bool,
    browser: bool,
    ocr: bool,
}

fn read_toggles(data_dir: &Path) -> CaptureToggles {
    let path = data_dir.join("capture-control.json");
    let defaults = CaptureToggles {
        window: true,
        browser: true,
        ocr: true,
    };
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return defaults,
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return defaults,
    };
    let t = v.get("toggles").unwrap_or(&v);
    CaptureToggles {
        window: t
            .get("window")
            .and_then(|x| x.as_bool())
            .unwrap_or(true),
        browser: t
            .get("browser")
            .and_then(|x| x.as_bool())
            .unwrap_or(true),
        ocr: t.get("ocr").and_then(|x| x.as_bool()).unwrap_or(true),
    }
}

fn load_control_into(
    data_dir: &Path,
    exes: &mut HashSet<String>,
    domains: &mut HashSet<String>,
) {
    let path = data_dir.join("capture-rules.json");
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = v.get("block_exe").and_then(|x| x.as_array()) {
                for a in arr {
                    if let Some(s) = a.as_str() {
                        exes.insert(s.to_lowercase());
                    }
                }
            }
            if let Some(arr) = v.get("block_domain").and_then(|x| x.as_array()) {
                for a in arr {
                    if let Some(s) = a.as_str() {
                        domains.insert(s.to_lowercase());
                    }
                }
            }
        }
    }
}

fn browser_history_paths() -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    if let Some(base) = BaseDirs::new() {
        let local = base.data_local_dir();
        out.push((
            "chrome",
            local
                .join("Google")
                .join("Chrome")
                .join("User Data")
                .join("Default")
                .join("History"),
        ));
        out.push((
            "edge",
            local
                .join("Microsoft")
                .join("Edge")
                .join("User Data")
                .join("Default")
                .join("History"),
        ));
    }
    out
}

fn chrome_time_to_rfc3339(visit_time: i64) -> String {
    let unix_us = visit_time - 11_644_473_600_000_000;
    let secs = unix_us / 1_000_000;
    let nsecs = ((unix_us % 1_000_000) * 1000) as u32;
    if let Some(dt) = DateTime::<Utc>::from_timestamp(secs, nsecs) {
        dt.to_rfc3339()
    } else {
        Utc::now().to_rfc3339()
    }
}

fn url_domain(url: &str) -> Option<String> {
    let u = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = u.split('/').next()?;
    Some(host.to_lowercase())
}

fn idle_seconds() -> u32 {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        use windows::Win32::System::SystemInformation::GetTickCount;
        unsafe {
            let mut info = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if GetLastInputInfo(&mut info).as_bool() {
                let tick = GetTickCount();
                return tick.saturating_sub(info.dwTime) / 1000;
            }
        }
        0
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn foreground_window_info() -> Option<(String, String, String)> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
        use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        };
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let len = GetWindowTextLengthW(hwnd);
            let mut buf = vec![0u16; (len + 1) as usize];
            let read = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..read as usize]);

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut exe = String::new();
            if pid != 0 {
                if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    let mut path = vec![0u16; MAX_PATH as usize];
                    let n = GetModuleFileNameExW(handle, None, &mut path);
                    if n > 0 {
                        exe = String::from_utf16_lossy(&path[..n as usize]);
                    }
                    let _ = CloseHandle(handle);
                }
            }
            let app = Path::new(&exe)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
            let exe_name = Path::new(&exe)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&exe)
                .to_string();
            Some((title, exe_name, app))
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

fn fnv1a_64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in data {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn is_chat_surface(app: &str, exe: &str, title: &str) -> bool {
    let blob = format!("{app} {exe} {title}").to_lowercase();
    [
        "whatsapp",
        "slack",
        "discord",
        "telegram",
        "teams",
        "signal",
        "web.whatsapp",
        "chat.google",
        "messages",
    ]
    .iter()
    .any(|k| blob.contains(k))
}

fn is_chat_url(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("whatsapp.com")
        || u.contains("web.telegram")
        || u.contains("t.me/")
        || u.contains("web.whatsapp")
}

/// Skip OCR on desks we never want as product (brokers, charts). Not a feature.
fn is_skip_ocr_desk(app: &str, exe: &str, title: &str, text: &str) -> bool {
    let blob = format!("{app} {exe} {title}").to_lowercase();
    // Messaging titles like "Trench - Raj" are chat, not a trading desk
    let chat = [
        "whatsapp",
        "slack",
        "discord",
        "telegram",
        "teams",
        "signal",
        "web.whatsapp",
        "chat.google",
        "messages",
    ]
    .iter()
    .any(|k| blob.contains(k));

    let apps = [
        "trench",
        "tradingview",
        "binance",
        "bybit",
        "okx",
        "hyperliquid",
        "robinhood",
        "webull",
        "tastytrade",
        "thinkorswim",
        "interactive brokers",
        "ibkr",
        "coinbase",
        "kraken",
        "ninjatrader",
        "tradovate",
        "metatrader",
    ];
    let desk = apps.iter().any(|k| blob.contains(k));
    if desk && !chat {
        return true;
    }
    let t = text.to_lowercase();
    if t.is_empty() {
        return false;
    }
    let ui = [
        "unrealized pn",
        "open interest",
        "tp/sl",
        "cross margin",
        "take profit",
        "stop loss",
        "liquidation",
        "oracle price",
    ]
    .iter()
    .filter(|k| t.contains(**k))
    .count();
    ui >= 2 && (t.contains("long") || t.contains("short") || t.contains("position"))
}

fn phash_from_rgb(width: u32, height: u32, rgba: &[u8]) -> u64 {
    let mut samples = [0u32; 64];
    for y in 0..8 {
        for x in 0..8 {
            let sx = (x * width / 8).min(width.saturating_sub(1));
            let sy = (y * height / 8).min(height.saturating_sub(1));
            let si = ((sy * width + sx) * 4) as usize;
            if si + 2 < rgba.len() {
                samples[y as usize * 8 + x as usize] =
                    (rgba[si] as u32 + rgba[si + 1] as u32 + rgba[si + 2] as u32) / 3;
            }
        }
    }
    let avg = samples.iter().sum::<u32>() / 64;
    let mut hash = 0u64;
    for (i, v) in samples.iter().enumerate() {
        if *v >= avg {
            hash |= 1u64 << i;
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(avg.to_le_bytes());
    let digest = hasher.finalize();
    hash ^ u64::from_le_bytes(digest[0..8].try_into().unwrap_or([0; 8]))
}

#[cfg(windows)]
fn filter_blocked_ocr_text(text: &str, block_domains: &HashSet<String>) -> String {
    if block_domains.is_empty() {
        return text.to_string();
    }
    text.lines()
        .filter(|line| {
            let l = line.to_lowercase();
            !block_domains.iter().any(|b| l.contains(b))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn foreground_pid() -> Option<u32> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                None
            } else {
                Some(pid)
            }
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// OCR the focused (or last-user) window only. Never fall back to a
/// fullscreen grab (that can include password vaults). Chat threads are
/// OCR'd so we can tell an ask from idle chat; bitmaps are not saved.
#[cfg(windows)]
fn capture_target_ocr(pid: u32, title: &str, crop_thread: bool) -> Option<(String, u64, bool)> {
    if let Some((text, phash)) = capture_window_ocr(pid, title, crop_thread) {
        if text.trim().len() >= 12 {
            return Some((text, phash, true));
        }
    }
    None
}

#[cfg(windows)]
fn capture_window_ocr(pid: u32, title: &str, crop_thread: bool) -> Option<(String, u64)> {
    use xcap::Window;
    if pid == 0 {
        return None;
    }
    let windows = Window::all().ok()?;
    let mut candidates: Vec<Window> = windows
        .into_iter()
        .filter(|w| {
            !w.is_minimized()
                && w.width() >= 120
                && w.height() >= 120
                && w.process_id() == pid
                && !w
                    .app_name()
                    .to_lowercase()
                    .contains("second-brain")
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by_key(|w| {
        let title_match = if w.title() == title { 0u8 } else { 1u8 };
        let area = (w.width() as u64).saturating_mul(w.height() as u64);
        (title_match, std::cmp::Reverse(area))
    });
    let win = &candidates[0];
    let img = match win.capture_image() {
        Ok(i) => i,
        Err(e) => {
            ocr_debug(&format!("window capture_image fail: {e}"));
            return None;
        }
    };
    let width = img.width();
    let height = img.height();
    let orig = img.into_raw();
    let mut rgba = orig.clone();
    let mut w = width;
    let mut h = height;
    // WhatsApp / Telegram desktop: skip the chat list, OCR the open thread.
    if crop_thread && w >= 700 {
        let cut = (w as f32 * 0.34) as u32;
        if let Some((cw, ch, cropped)) = crop_rgba_right(w, h, &rgba, cut) {
            w = cw;
            h = ch;
            rgba = cropped;
        }
    }
    let phash = phash_from_rgb(w, h, &rgba);
    let body = win_ocr_rgba(w, h, &rgba)?;
    let text = if crop_thread {
        if let Some(header) = ocr_chat_header(width, height, &orig) {
            format!("HEADER: {header}\n{body}")
        } else {
            body
        }
    } else {
        body
    };
    Some((text, phash))
}

/// Thread title bar: milder left cut than the body so the name isn't sliced off.
#[cfg(windows)]
fn ocr_chat_header(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    if height < 180 || width < 400 {
        return None;
    }
    let cut = (width as f32 * 0.22) as u32;
    let (cw, ch, thread) = crop_rgba_right(width, height, rgba, cut)?;
    let header_h = ((ch as f32) * 0.12).clamp(80.0, 130.0) as u32;
    let (hw, hh, head) = crop_rgba_top(cw, ch, &thread, header_h)?;
    let keep = ((hw as f32) * 0.78) as u32;
    let (nw, nh, name_bar) = crop_rgba_keep_left(hw, hh, &head, keep)?;
    let header = win_ocr_rgba(nw, nh, &name_bar)?;
    let header = header.replace('\n', " ").trim().to_string();
    if header.len() < 2 {
        return None;
    }
    Some(header)
}

/// Keep the top `keep_h` rows (chat name bar).
fn crop_rgba_top(
    width: u32,
    height: u32,
    rgba: &[u8],
    keep_h: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    if keep_h < 24 || keep_h >= height {
        return None;
    }
    let stride = (width * 4) as usize;
    let bytes = stride * keep_h as usize;
    if rgba.len() < bytes {
        return None;
    }
    Some((width, keep_h, rgba[..bytes].to_vec()))
}

/// Keep the left `keep_w` columns (drop call-button icons on the right).
fn crop_rgba_keep_left(
    width: u32,
    height: u32,
    rgba: &[u8],
    keep_w: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    if keep_w < 80 || keep_w >= width {
        return None;
    }
    let src_stride = (width * 4) as usize;
    let row_bytes = (keep_w * 4) as usize;
    let mut out = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        let start = y * src_stride;
        out.extend_from_slice(&rgba[start..start + row_bytes]);
    }
    Some((keep_w, height, out))
}

/// Drop the left `cut_x` columns (chat list). RGBA, 4 bytes/pixel.
fn crop_rgba_right(
    width: u32,
    height: u32,
    rgba: &[u8],
    cut_x: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    if cut_x == 0 || cut_x >= width.saturating_sub(200) {
        return None;
    }
    let new_w = width - cut_x;
    let mut out = Vec::with_capacity((new_w * height * 4) as usize);
    let src_stride = (width * 4) as usize;
    let dst_off = (cut_x * 4) as usize;
    let row_bytes = (new_w * 4) as usize;
    for y in 0..height as usize {
        let start = y * src_stride + dst_off;
        out.extend_from_slice(&rgba[start..start + row_bytes]);
    }
    Some((new_w, height, out))
}

/// Capture every monitor (full desktop), OCR each, concatenate text.
#[cfg(windows)]
#[allow(dead_code)]
fn capture_fullscreen_ocr() -> Option<(String, u64)> {
    use xcap::Monitor;
    let monitors = Monitor::all().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let mut texts: Vec<String> = Vec::new();
    let mut combined_phash: u64 = 0;
    for (i, monitor) in monitors.into_iter().enumerate() {
        let Ok(img) = monitor.capture_image() else {
            continue;
        };
        let width = img.width();
        let height = img.height();
        let rgba = img.into_raw();
        let phash = phash_from_rgb(width, height, &rgba);
        combined_phash ^= phash.rotate_left((i as u32 * 7) % 63);
        if let Some(t) = win_ocr_rgba(width, height, &rgba) {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() {
                texts.push(trimmed);
            }
        }
    }
    if texts.is_empty() {
        return None;
    }
    Some((texts.join("\n\n"), combined_phash))
}

/// Encode PNG → WinRT BitmapDecoder → OcrEngine.
/// (Direct CreateCopyFromBuffer was returning ~100 chars of gibberish.)
#[cfg(windows)]
fn win_ocr_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    use image::{imageops::FilterType, ImageBuffer, ImageFormat, Rgba};
    use std::io::Cursor;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat,
    };
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    if width < 8 || height < 8 || rgba.len() < (width as usize * height as usize * 4) {
        ocr_debug(&format!("skip bad dims {width}x{height} len={}", rgba.len()));
        return None;
    }

    let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba.to_vec())?;

    // Dark WhatsApp/Telegram: invert so WinOCR sees black text on a light field.
    let raw = img.as_raw();
    let mut sum: u64 = 0;
    let mut n: u64 = 0;
    let mut i = 0usize;
    while i + 2 < raw.len() {
        sum += u64::from(raw[i]) + u64::from(raw[i + 1]) + u64::from(raw[i + 2]);
        n += 1;
        i += 32; // every 8th pixel
    }
    if n > 0 && (sum / (n * 3)) < 110 {
        for p in img.pixels_mut() {
            p[0] = 255 - p[0];
            p[1] = 255 - p[1];
            p[2] = 255 - p[2];
        }
    }

    // Thin header strips fail OCR; blow them up first.
    if img.height() < 160 {
        let scale = (160.0 / img.height() as f32).clamp(1.5, 3.0);
        let nw = ((img.width() as f32) * scale).round().max(1.0) as u32;
        let nh = ((img.height() as f32) * scale).round().max(1.0) as u32;
        img = image::imageops::resize(&img, nw, nh, FilterType::CatmullRom);
    }

    // Keep chat bubbles readable; avoid crushing to tiny bitmaps
    let max_w = 1800u32;
    if img.width() > max_w {
        let nh = ((img.height() as f32) * (max_w as f32 / img.width() as f32)).max(1.0) as u32;
        img = image::imageops::resize(&img, max_w, nh, FilterType::Triangle);
    }

    let mut png_buf = Cursor::new(Vec::new());
    if let Err(e) = img.write_to(&mut png_buf, ImageFormat::Png) {
        ocr_debug(&format!("png encode fail: {e}"));
        return None;
    }
    let png_bytes = png_buf.into_inner();
    if png_bytes.len() < 32 {
        ocr_debug("png too small");
        return None;
    }

    let stream = match InMemoryRandomAccessStream::new() {
        Ok(s) => s,
        Err(e) => {
            ocr_debug(&format!("stream fail: {e}"));
            return None;
        }
    };
    {
        let writer = match DataWriter::CreateDataWriter(&stream) {
            Ok(w) => w,
            Err(e) => {
                ocr_debug(&format!("writer fail: {e}"));
                return None;
            }
        };
        if let Err(e) = writer.WriteBytes(&png_bytes) {
            ocr_debug(&format!("writebytes fail: {e}"));
            return None;
        }
        if writer.StoreAsync().and_then(|o| o.get()).is_err() {
            ocr_debug("storeasync fail");
            return None;
        }
        let _ = writer.FlushAsync().and_then(|o| o.get());
        let _ = writer.DetachStream();
    }
    if stream.Seek(0).is_err() {
        ocr_debug("seek fail");
        return None;
    }

    let decoder = match BitmapDecoder::CreateAsync(&stream).and_then(|o| o.get()) {
        Ok(d) => d,
        Err(e) => {
            ocr_debug(&format!("decoder fail: {e}"));
            return None;
        }
    };
    // Gray8 is what WinOCR expects most reliably
    let bitmap = match decoder
        .GetSoftwareBitmapConvertedAsync(BitmapPixelFormat::Gray8, BitmapAlphaMode::Ignore)
        .and_then(|o| o.get())
    {
        Ok(b) => b,
        Err(e) => {
            ocr_debug(&format!("bitmap convert fail: {e}"));
            // fallback unconverted
            match decoder.GetSoftwareBitmapAsync().and_then(|o| o.get()) {
                Ok(b) => b,
                Err(e2) => {
                    ocr_debug(&format!("bitmap raw fail: {e2}"));
                    return None;
                }
            }
        }
    };
    let engine = match OcrEngine::TryCreateFromUserProfileLanguages() {
        Ok(e) => e,
        Err(e) => {
            ocr_debug(&format!("ocr engine fail: {e}"));
            return None;
        }
    };
    let result = match engine.RecognizeAsync(&bitmap).and_then(|o| o.get()) {
        Ok(r) => r,
        Err(e) => {
            ocr_debug(&format!("recognize fail: {e}"));
            return None;
        }
    };
    let text = match result.Text() {
        Ok(t) => t.to_string(),
        Err(e) => {
            ocr_debug(&format!("text fail: {e}"));
            return None;
        }
    };
    ocr_debug(&format!(
        "ocr ok {}x{} png={} chars={} sample={:?}",
        img.width(),
        img.height(),
        png_bytes.len(),
        text.len(),
        text.chars().take(80).collect::<String>()
    ));
    Some(text)
}

#[cfg(windows)]
fn ocr_debug(_msg: &str) {}

#[cfg(not(windows))]
fn ocr_debug(_msg: &str) {}

#[cfg(not(windows))]
fn capture_target_ocr(_pid: u32, _title: &str) -> Option<(String, u64, bool)> {
    None
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn capture_fullscreen_ocr() -> Option<(String, u64)> {
    None
}

#[cfg(not(windows))]
fn filter_blocked_ocr_text(text: &str, _block_domains: &HashSet<String>) -> String {
    text.to_string()
}
