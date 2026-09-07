//! Linux foreground-window + idle detection + accessibility bootstrap.
//!
//! Foreground titles come from the compositor in order Hyprland -> Sway ->
//! niri -> GNOME Shell -> X11 (xprop), each shelled out or D-Bus-queried
//! with a hard timeout so a dead compositor socket can never stall the
//! capture thread. Idle time uses the session-native source (XScreenSaver,
//! Mutter IdleMonitor, ext-idle-notify). The a11y helpers own
//! `org.a11y.Status`, start the AT-SPI bus when missing, and heal a stale
//! bus owner. Crates beyond std: serde_json, zbus, wayland-client/protocols.
#![cfg(target_os = "linux")]

use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};
use zbus::blocking::Connection as BlockingConnection;
use zbus::names::BusName;

const CMD_TIMEOUT: Duration = Duration::from_secs(2);

/// Exit status of a helper, ignoring output. For commands that succeed
/// silently (`gsettings set`, daemon launches) — `run_fast` would mistake
/// their empty stdout for failure.
fn run_ok(prog: &str, args: &[&str]) -> bool {
    let mut child = match Command::new(prog)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = Instant::now() + CMD_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
}

/// Run a helper, kill it past the deadline, return trimmed stdout.
fn run_fast(prog: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(prog)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + CMD_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let mut out = String::new();
    child
        .stdout
        .take()?
        .read_to_string(&mut out)
        .ok()
        .map(|_| out.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve /proc/<pid>/exe to (exe_name, app). Falls back to `fallback`.
fn exe_for_pid(pid: u32, fallback: &str) -> (String, String) {
    if pid != 0 {
        if let Ok(link) = std::fs::read_link(format!("/proc/{pid}/exe")) {
            let exe = link
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(fallback)
                .to_string();
            let app = link
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&exe)
                .to_string();
            if !exe.is_empty() {
                return (exe, app);
            }
        }
    }
    let f = fallback.to_lowercase();
    (f.clone(), f)
}

fn finish(title: String, pid: u32, class: &str) -> Option<(String, String, String)> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let (exe, mut app) = exe_for_pid(pid, class);
    if app.is_empty() || app == "unknown" {
        app = class.to_lowercase();
    }
    Some((title, exe, app))
}

/// Hyprland `fullscreen` field: 0 windowed, 1 maximized, 2 fullscreen,
/// 3 maximized + fullscreen. Maximized is still a window; only an
/// exclusive fullscreen claims the output.
fn hypr_fullscreen(v: &serde_json::Value) -> bool {
    v.get("fullscreen").and_then(|f| f.as_u64()).unwrap_or(0) >= 2
}

fn hyprland_active() -> Option<(String, u32, String, bool)> {
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_err()
        && find_on_path("hyprctl").is_none()
    {
        return None;
    }
    let out = run_fast("hyprctl", &["activewindow", "-j"])?;
    let v: serde_json::Value = serde_json::from_str(&out).ok()?;
    let title = v.get("title")?.as_str()?.to_string();
    let class = v.get("class")?.as_str().unwrap_or("").to_string();
    let pid = v.get("pid")?.as_u64()? as u32;
    if pid == 0 {
        return None;
    }
    Some((title, pid, class, hypr_fullscreen(&v)))
}

fn sway_focused(node: &serde_json::Value, best: &mut Option<(String, u32, String, bool)>) {
    if let Some(obj) = node.as_object() {
        let focused = obj.get("focused").and_then(|f| f.as_bool()).unwrap_or(false);
        if focused {
            if let (Some(name), Some(pid)) = (
                obj.get("name").and_then(|n| n.as_str()),
                obj.get("pid").and_then(|p| p.as_u64()),
            ) {
                let app = obj
                    .get("app_id")
                    .and_then(|a| a.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        obj.get("window_properties")
                            .and_then(|w| w.get("class"))
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();
                // Sway fullscreen_mode: 0 windowed, 1 output-fullscreen,
                // 2 global fullscreen. Any nonzero claims the output.
                let fullscreen = obj
                    .get("fullscreen_mode")
                    .and_then(|m| m.as_u64())
                    .unwrap_or(0)
                    != 0;
                // Deepest focused node wins: overwrite as we descend.
                *best = Some((name.to_string(), pid as u32, app, fullscreen));
            }
        }
        if let Some(nodes) = obj.get("nodes").and_then(|n| n.as_array()) {
            for n in nodes {
                sway_focused(n, best);
            }
        }
        if let Some(nodes) = obj.get("floating_nodes").and_then(|n| n.as_array()) {
            for n in nodes {
                sway_focused(n, best);
            }
        }
    } else if let Some(arr) = node.as_array() {
        for n in arr {
            sway_focused(n, best);
        }
    }
}

/// niri focused window via its IPC (`NIRI_SOCKET`). Shape:
/// `{"id":1,"title":"…","app_id":"…","pid":123,"is_fullscreen":false}`.
/// Unverifiable in CI (no niri session here); parse defensively.
fn parse_niri_window(v: &serde_json::Value) -> Option<(String, u32, String, bool)> {
    let obj = v.as_object()?;
    let title = obj.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let pid = obj.get("pid").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
    let app = obj
        .get("app_id")
        .and_then(|a| a.as_str())
        .unwrap_or("")
        .to_string();
    let fullscreen = obj
        .get("is_fullscreen")
        .and_then(|f| f.as_bool())
        .unwrap_or(false);
    if pid == 0 {
        return None;
    }
    Some((title, pid, app, fullscreen))
}

fn niri_active() -> Option<(String, u32, String, bool)> {
    if std::env::var("NIRI_SOCKET").is_err() && find_on_path("niri").is_none() {
        return None;
    }
    let out = run_fast("niri", &["msg", "--json", "focused-window"])?;
    let v: serde_json::Value = serde_json::from_str(&out).ok()?;
    if v.is_null() {
        return None;
    }
    parse_niri_window(&v)
}

/// GNOME has no focus CLI; ask the shell itself over D-Bus. `Eval` runs on
/// stock GNOME (hardened setups may disable it) and returns a JSON string.
/// Unverifiable in CI (no GNOME session here); the script is deliberately
/// one expression with a null-safe guard.
const GNOME_FOCUS_SCRIPT: &str = "global.display.focus_window ? JSON.stringify({t: global.display.focus_window.get_title(), p: global.display.focus_window.get_pid(), c: global.display.focus_window.get_wm_class(), f: global.display.focus_window.is_fullscreen()}) : \"null\"";

fn parse_gnome_focus(success: bool, result: &str) -> Option<(String, u32, String, bool)> {
    if !success {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(result).ok()?;
    if v.is_null() {
        return None;
    }
    let obj = v.as_object()?;
    let title = obj.get("t").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let pid = obj.get("p").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
    let app = obj.get("c").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let fullscreen = obj.get("f").and_then(|f| f.as_bool()).unwrap_or(false);
    if pid == 0 {
        return None;
    }
    Some((title, pid, app, fullscreen))
}

fn gnome_active() -> Option<(String, u32, String, bool)> {
    if !desktop_is(&["gnome", "ubuntu"]) {
        return None;
    }
    let conn = BlockingConnection::session().ok()?;
    let proxy =
        zbus::blocking::Proxy::new(&conn, "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell")
            .ok()?;
    let (success, result): (bool, String) =
        proxy.call("Eval", &(GNOME_FOCUS_SCRIPT,)).ok()?;
    parse_gnome_focus(success, &result)
}

fn sway_active() -> Option<(String, u32, String, bool)> {
    if std::env::var("SWAYSOCK").is_err() && find_on_path("swaymsg").is_none() {
        return None;
    }
    let out = run_fast("swaymsg", &["-t", "get_tree"])?;
    let v: serde_json::Value = serde_json::from_str(&out).ok()?;
    let mut best = None;
    sway_focused(&v, &mut best);
    best
}

/// Decode one xprop quoted string: handles \" \\ and \ooo octal escapes.
fn unquote_xprop(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let n = bytes[i + 1];
            if n == b'"' || n == b'\\' {
                out.push(n);
                i += 2;
                continue;
            }
            if n.is_ascii_digit() && i + 3 < bytes.len() + 1 {
                let end = (i + 4).min(bytes.len());
                if let Ok(oct) = std::str::from_utf8(&bytes[i + 1..end]) {
                    if oct.len() == 3 && oct.bytes().all(|b| b.is_ascii_digit()) {
                        if let Ok(v) = u8::from_str_radix(oct, 8) {
                            out.push(v);
                            i += 4;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Split an xprop line `NAME(TYPE) = value` into (name, raw value).
fn split_xprop_line(line: &str) -> Option<(&str, &str)> {
    let (left, value) = line.split_once('=')?;
    let name = left.split_once('(')?.0.trim();
    Some((name, value.trim()))
}

/// Collect every "..." quoted segment of an xprop value, decoded.
fn quoted_segments(value: &str) -> Vec<String> {
    let mut segs = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let mut j = i + 1;
            let mut escaped = false;
            while j < bytes.len() {
                if escaped {
                    escaped = false;
                } else if bytes[j] == b'\\' {
                    escaped = true;
                } else if bytes[j] == b'"' {
                    break;
                }
                j += 1;
            }
            segs.push(unquote_xprop(&value[i + 1..j.min(bytes.len())]));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    segs
}

/// True when an EWMH state list carries the fullscreen atom.
fn has_fullscreen_atom(state_value: &str) -> bool {
    state_value
        .split(',')
        .any(|a| a.trim() == "_NET_WM_STATE_FULLSCREEN")
}

fn x11_active() -> Option<(String, u32, String, bool)> {
    if std::env::var("DISPLAY").is_err() && std::env::var("WAYLAND_DISPLAY").is_err() {
        return None;
    }
    let root = run_fast("xprop", &["-root", "_NET_ACTIVE_WINDOW"])?;
    // `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1400007`
    let id = root.split('#').nth(1)?.trim().to_string();
    if id == "0x0" {
        return None;
    }
    let props = run_fast(
        "xprop",
        &[
            "-id",
            &id,
            "_NET_WM_PID",
            "_NET_WM_NAME",
            "WM_NAME",
            "WM_CLASS",
            "_NET_WM_STATE",
        ],
    )?;
    let mut pid = 0u32;
    let mut net_name: Option<String> = None;
    let mut wm_name: Option<String> = None;
    let mut class = String::new();
    let mut fullscreen = false;
    for line in props.lines() {
        let Some((name, value)) = split_xprop_line(line) else {
            continue;
        };
        match name {
            "_NET_WM_PID" => {
                pid = value
                    .split_whitespace()
                    .next()?
                    .parse::<u32>()
                    .unwrap_or(0);
            }
            "_NET_WM_NAME" => {
                net_name = quoted_segments(value).into_iter().next();
            }
            "WM_NAME" => {
                wm_name = quoted_segments(value).into_iter().next();
            }
            "WM_CLASS" => {
                let segs = quoted_segments(value);
                // ("instance", "Class") — the class is the stable one.
                class = segs.into_iter().next_back().unwrap_or_default();
            }
            "_NET_WM_STATE" => {
                fullscreen = has_fullscreen_atom(value);
            }
            _ => {}
        }
    }
    let title = net_name.or(wm_name).unwrap_or_default();
    Some((title, pid, class, fullscreen))
}

/// In-process PATH lookup: no subprocess, no shell.
fn find_on_path(prog: &str) -> Option<String> {
    if prog.contains('/') {
        let p = Path::new(prog);
        return is_executable(p).then(|| prog.to_string());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(prog);
        if is_executable(&cand) {
            return cand.to_str().map(|s| s.to_string());
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// (window_title, exe_name, app), mirroring the Windows/macOS shape.
pub fn foreground_window_info() -> Option<(String, String, String)> {
    foreground_all().map(|(title, exe, app, _, _)| (title, exe, app))
}

pub fn foreground_pid() -> Option<u32> {
    foreground_all().map(|(_, _, _, pid, _)| pid)
}

/// One compositor query: (window_title, exe_name, app, pid, fullscreen).
/// Prefer this over info + pid pairs — it used to cost two queries.
pub fn foreground_all() -> Option<(String, String, String, u32, bool)> {
    if let Some((title, pid, class, fullscreen)) = hyprland_active() {
        return finish(title, pid, &class).map(|(t, e, a)| (t, e, a, pid, fullscreen));
    }
    if let Some((title, pid, app, fullscreen)) = sway_active() {
        return finish(title, pid, &app).map(|(t, e, a)| (t, e, a, pid, fullscreen));
    }
    if let Some((title, pid, app, fullscreen)) = niri_active() {
        return finish(title, pid, &app).map(|(t, e, a)| (t, e, a, pid, fullscreen));
    }
    if let Some((title, pid, app, fullscreen)) = gnome_active() {
        return finish(title, pid, &app).map(|(t, e, a)| (t, e, a, pid, fullscreen));
    }
    if let Some((title, pid, class, fullscreen)) = x11_active() {
        return finish(title, pid, &class).map(|(t, e, a)| (t, e, a, pid, fullscreen));
    }
    None
}

fn is_x11_session() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_err() && std::env::var("DISPLAY").is_ok()
}

fn desktop_is(names: &[&str]) -> bool {
    let cur = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let cur_l = cur.to_lowercase();
    names.iter().any(|n| cur_l.contains(&n.to_lowercase()))
}

/// Seconds since last input, per the session's native idle source.
/// Unknown source reports 0 (fail open: keep capturing).
pub fn idle_seconds() -> u32 {
    if is_x11_session() {
        return x11_idle_seconds();
    }
    if desktop_is(&["gnome", "cinnamon", "pantheon"]) {
        if let Some(s) = mutter_idle_seconds() {
            return s;
        }
    }
    wayland_idle_seconds()
}

/// XScreenSaver idle time. X11 sessions only: under XWayland the X server
/// never sees Wayland input, so its counter would report false idle.
fn x11_idle_seconds() -> u32 {
    run_fast("xprintidle", &[])
        .and_then(|s| s.parse::<u64>().ok())
        .map(|ms| (ms / 1000).min(u32::MAX as u64) as u32)
        .unwrap_or(0)
}

/// GNOME/Cinnamon/Pantheon idle time over D-Bus (Mutter IdleMonitor).
fn mutter_idle_seconds() -> Option<u32> {
    let conn = BlockingConnection::session().ok()?;
    for (service, path, iface) in [
        (
            "org.gnome.Mutter.IdleMonitor",
            "/org/gnome/Mutter/IdleMonitor",
            "org.gnome.Mutter.IdleMonitor",
        ),
        (
            "org.cinnamon.Mutter.IdleMonitor",
            "/org/cinnamon/Mutter/IdleMonitor",
            "org.cinnamon.Mutter.IdleMonitor",
        ),
    ] {
        // Proxy construction never touches the bus, so a missing service
        // only surfaces at call time — keep trying the next candidate.
        let Ok(proxy) = zbus::blocking::Proxy::new(&conn, service, path, iface) else {
            continue;
        };
        if let Ok(ms) = proxy.call::<_, _, u64>("GetIdletime", &()) {
            return Some((ms / 1000).min(u32::MAX as u64) as u32);
        }
    }
    None
}

struct IdleShared {
    supported: AtomicBool,
    last_active: std::sync::Mutex<Instant>,
}

static WAYLAND_IDLE: OnceLock<std::sync::Arc<IdleShared>> = OnceLock::new();

/// wlroots/KDE Wayland idle via ext-idle-notify: a watcher thread owns the
/// Wayland connection and records the last activity timestamp.
fn wayland_idle_seconds() -> u32 {
    let shared = WAYLAND_IDLE
        .get_or_init(|| {
            let shared = std::sync::Arc::new(IdleShared {
                supported: AtomicBool::new(false),
                last_active: std::sync::Mutex::new(Instant::now()),
            });
            let worker = std::sync::Arc::clone(&shared);
            thread::spawn(move || idle_notify_thread(worker));
            shared
        })
        .clone();
    if !shared.supported.load(Ordering::SeqCst) {
        // Watcher still starting, or protocol absent: fail open.
        // The thread flips `supported` once the first roundtrip succeeds,
        // so a missing protocol settles at 0 within milliseconds.
        return 0;
    }
    shared
        .last_active
        .lock()
        .map(|t| t.elapsed().as_secs().min(u32::MAX as u64) as u32)
        .unwrap_or(0)
}

fn idle_notify_thread(shared: std::sync::Arc<IdleShared>) {
    use wayland_client::{
        Connection as WlConnection, Dispatch, QueueHandle,
        protocol::{wl_registry, wl_seat},
    };
    use wl_seat::WlSeat;
    use wayland_protocols::ext::idle_notify::v1::client::{
        ext_idle_notification_v1, ext_idle_notifier_v1,
    };

    struct State {
        seat: Option<WlSeat>,
        notifier: Option<ext_idle_notifier_v1::ExtIdleNotifierV1>,
        shared: std::sync::Arc<IdleShared>,
    }

    impl Dispatch<wl_registry::WlRegistry, ()> for State {
        fn event(
            state: &mut Self,
            proxy: &wl_registry::WlRegistry,
            event: wl_registry::Event,
            _: &(),
            _: &WlConnection,
            qh: &QueueHandle<Self>,
        ) {
            if let wl_registry::Event::Global { name, interface, version } = event {
                match interface.as_str() {
                    "wl_seat" if state.seat.is_none() => {
                        state.seat = Some(proxy.bind(name, version.min(9), qh, ()));
                    }
                    "ext_idle_notifier_v1" if state.notifier.is_none() => {
                        state.notifier = Some(proxy.bind(name, 1, qh, ()));
                    }
                    _ => {}
                }
            }
        }
    }
    impl Dispatch<WlSeat, ()> for State {
        fn event(
            _: &mut Self,
            _: &WlSeat,
            _: wl_seat::Event,
            _: &(),
            _: &WlConnection,
            _: &QueueHandle<Self>,
        ) {
        }
    }
    impl Dispatch<ext_idle_notifier_v1::ExtIdleNotifierV1, ()> for State {
        fn event(
            _: &mut Self,
            _: &ext_idle_notifier_v1::ExtIdleNotifierV1,
            _: ext_idle_notifier_v1::Event,
            _: &(),
            _: &WlConnection,
            _: &QueueHandle<Self>,
        ) {
        }
    }
    impl Dispatch<ext_idle_notification_v1::ExtIdleNotificationV1, ()> for State {
        fn event(
            state: &mut Self,
            _: &ext_idle_notification_v1::ExtIdleNotificationV1,
            event: ext_idle_notification_v1::Event,
            _: &(),
            _: &WlConnection,
            _: &QueueHandle<Self>,
        ) {
            if matches!(event, ext_idle_notification_v1::Event::Resumed) {
                if let Ok(mut t) = state.shared.last_active.lock() {
                    *t = Instant::now();
                }
            }
        }
    }

    let conn = match WlConnection::connect_to_env() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    let _registry = conn.display().get_registry(&qh, ());
    // Idle threshold mirrors the capture loop's idle limit.
    const IDLE_THRESHOLD_MS: u32 = 120_000;
    let mut state = State { seat: None, notifier: None, shared: std::sync::Arc::clone(&shared) };
    if queue.roundtrip(&mut state).is_err() {
        return;
    }
    let (Some(seat), Some(notifier)) = (state.seat.take(), state.notifier.take()) else {
        return;
    };
    let _notification =
        notifier.get_idle_notification(IDLE_THRESHOLD_MS, &seat, &qh, ());
    if queue.flush().is_err() {
        return;
    }
    shared.supported.store(true, Ordering::SeqCst);
    loop {
        if queue.blocking_dispatch(&mut state).is_err() {
            break;
        }
    }
    shared.supported.store(false, Ordering::SeqCst);
}

/// Owned bus name for a D-Bus presence check.
fn bus_name(name: &str) -> Option<BusName<'static>> {
    BusName::try_from(name.to_string()).ok()
}

fn a11y_bus_present() -> bool {
    let session = match BlockingConnection::session() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let proxy = match zbus::blocking::fdo::DBusProxy::new(&session) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let Some(name) = bus_name("org.a11y.Bus") else {
        return false;
    };
    proxy.name_has_owner(name).unwrap_or(false)
}

/// Tell toolkits an assistive client is active so they expose AT-SPI trees.
///
/// There is no `org.a11y.Status` owner outside GNOME, so this flips the
/// setting toolkits actually read: the `toolkit-accessibility` dconf key.
/// Session-scoped (resets only if the user changes it) and verified by
/// reading the key back. Chromium additionally needs
/// `--force-renderer-accessibility`, Qt `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`.
pub fn ensure_session_accessibility() -> bool {
    if find_on_path("gsettings").is_none() {
        return false;
    }
    if !run_ok(
        "gsettings",
        &[
            "set",
            "org.gnome.desktop.interface",
            "toolkit-accessibility",
            "true",
        ],
    ) {
        return false;
    }
    run_fast(
        "gsettings",
        &["get", "org.gnome.desktop.interface", "toolkit-accessibility"],
    )
    .is_some_and(|v| v.trim() == "true")
}

/// Address the session's accessibility bus daemon advertises.
fn a11y_bus_address() -> Option<String> {
    let session = BlockingConnection::session().ok()?;
    let addr = atspi_proxies::bus::BusProxyBlocking::builder(&session)
        .destination("org.a11y.Bus")
        .ok()?
        .path("/org/a11y/bus")
        .ok()?
        .build()
        .ok()?
        .get_address()
        .ok()
        .filter(|a| !a.is_empty())?;
    Some(addr)
}

/// The name is owned AND its socket accepts connections. A stale launcher
/// (socket dir wiped under it) keeps the name while serving nothing — that
/// reads as "present" but breaks every AT-SPI client in the session.
fn a11y_bus_alive() -> bool {
    if !a11y_bus_present() {
        return false;
    }
    let Some(addr) = a11y_bus_address() else {
        return false;
    };
    zbus::blocking::connection::Builder::address(addr.as_str())
        .and_then(|b| b.build())
        .is_ok()
}

/// PID behind a session-bus name.
fn bus_owner_pid(name: &str) -> Option<u32> {
    let session = BlockingConnection::session().ok()?;
    let proxy = zbus::blocking::fdo::DBusProxy::new(&session).ok()?;
    proxy
        .get_connection_unix_process_id(bus_name(name)?)
        .ok()
}

/// Only a same-user AT-SPI launcher may be restarted: never touch screen
/// readers, unknown squatters, our own process, or another user's daemon.
fn owner_is_restartable_launcher(pid: u32) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    let exe = std::fs::read_link(format!("/proc/{pid}/exe"));
    let launcher = exe
        .as_ref()
        .ok()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "at-spi-bus-launcher" || n == "at-spi-dbus-bus");
    if !launcher {
        return false;
    }
    let owner = std::fs::metadata(format!("/proc/{pid}")).map(|m| m.uid());
    let me = std::fs::metadata("/proc/self").map(|m| m.uid());
    matches!((owner, me), (Ok(a), Ok(b)) if a == b)
}

/// A stale launcher owns `org.a11y.Bus` but its socket is dead, so no
/// client can connect. Ask it to exit (SIGTERM; the bus daemon then
/// releases the name) so a fresh launcher can take over. Returns true
/// once the name is free.
fn reap_stale_a11y_owner() -> bool {
    let Some(pid) = bus_owner_pid("org.a11y.Bus") else {
        return false;
    };
    if !owner_is_restartable_launcher(pid) {
        return false;
    }
    // SAFETY: pid is a validated same-user launcher, not ourselves; SIGTERM
    // asks a user-session daemon to exit, matching what session teardown
    // would do. ESRCH/E PERM just mean it is already gone or untouchable.
    let termed = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) == 0 };
    if !termed {
        return bus_gone();
    }
    for _ in 0..20 {
        if bus_gone() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    bus_gone()
}

fn bus_gone() -> bool {
    !a11y_bus_present()
}

/// Start the accessibility bus when the session did not bring one up.
pub fn ensure_a11y_bus() -> bool {
    if a11y_bus_alive() {
        return true;
    }
    if a11y_bus_present() {
        // Owned but unreachable: every AT-SPI client is already broken, so
        // reap the stale same-user launcher instead of standing down.
        // Anything else owning the name is left strictly alone.
        reap_stale_a11y_owner();
    }
    // Distros ship the launcher outside PATH (Arch: /usr/lib, Fedora/RHEL:
    // /usr/libexec); fall back to those absolute locations.
    let launcher = find_on_path("at-spi-bus-launcher").or_else(|| {
        [
            "/usr/lib/at-spi-bus-launcher",
            "/usr/libexec/at-spi-bus-launcher",
        ]
        .into_iter()
        .find(|p| is_executable(Path::new(p)))
        .map(str::to_string)
    });
    let Some(launcher) = launcher else {
        return false;
    };
    // Fire and forget: the launcher owns the bus on its own lifetime, so it
    // must never be killed on a timeout. A reaper thread collects the child.
    let mut child = match Command::new(launcher)
        .arg("--launch-immediately")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    thread::spawn(move || {
        let _ = child.wait();
    });
    for _ in 0..10 {
        // Alive, not just present: a fresh launcher must serve a socket
        // clients can actually connect to.
        if a11y_bus_alive() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

/// The `org.a11y.Status` service toolkits watch: when owned with
/// `IsEnabled` and `ScreenReaderEnabled` true (the same pair Orca and
/// gnome-settings-daemon publish), GTK/Qt/Chromium expose AT-SPI trees.
struct A11yStatusOwner;

#[zbus::interface(name = "org.a11y.Status")]
impl A11yStatusOwner {
    #[zbus(property)]
    fn is_enabled(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn screen_reader_enabled(&self) -> bool {
        true
    }
}

static STATUS_OWNER: OnceLock<()> = OnceLock::new();

/// Claim `org.a11y.Status` so toolkits expose AT-SPI trees while we run.
/// Takes the name only when nobody owns it (screen readers and
/// gnome-settings-daemon defer to); dropping the connection on exit releases
/// it, restoring the previous state.
fn serve_a11y_status() {
    STATUS_OWNER.get_or_init(|| {
        thread::spawn(|| {
            let conn = zbus::blocking::connection::Builder::session()
                .and_then(|b| b.serve_at("/org/a11y/status", A11yStatusOwner))
                .and_then(|b| b.build())
                .ok();
            let conn = match conn {
                Some(c) => c,
                None => return,
            };
            let owned = matches!(
                conn.request_name_with_flags(
                    "org.a11y.Status",
                    enumflags2::BitFlags::empty(),
                ),
                Ok(zbus::fdo::RequestNameReply::PrimaryOwner)
            );
            if !owned {
                return;
            }
            // Park holding the connection; its drop releases the name.
            loop {
                thread::sleep(Duration::from_secs(3600));
            }
        });
    });
}

/// One-time Linux bootstrap for ambient capture. Best effort and silent.
pub fn bootstrap() {
    ensure_a11y_bus();
    ensure_session_accessibility();
    serve_a11y_status();
}

static AX_GAP_LOGGED: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    OnceLock::new();

/// Chromium-family executable names whose renderers stay silent without the
/// accessibility flag (Electron apps embed the same engine).
const CHROMIUM_EXES: &[&str] = &[
    "chrome",
    "chromium",
    "chromium-browser",
    "brave",
    "brave-browser",
    "msedge",
    "edge",
    "opera",
    "vivaldi",
];

/// Why a focused app exposes no AT-SPI tree, from its own /proc records.
/// Pure over caller-supplied bytes so it stays unit-testable: NUL-separated
/// `cmdline` and `environ` as the kernel serves them, plus `maps` text.
/// Qt is detected by linked library, never by environment: session-wide
/// `QT_QPA_PLATFORM` is inherited by every GUI app, Qt or not.
fn ax_gap_hint(exe: &str, cmdline: &[u8], environ: &[u8], maps: &[u8]) -> Option<&'static str> {
    let exe_l = exe.to_lowercase();
    let is_chromium = CHROMIUM_EXES.iter().any(|c| exe_l.contains(c))
        || cmdline
            .split(|b| *b == 0)
            .any(|a| a == b"--type=renderer" || a == b"--type=zygote");
    if is_chromium
        && !cmdline
            .split(|b| *b == 0)
            .any(|a| a == b"--force-renderer-accessibility")
    {
        return Some(
            "Chromium/Electron exposes no accessibility tree unless started \
             with --force-renderer-accessibility; titles + history only",
        );
    }
    let qt_app = maps
        .windows(b"libQt6Core.so".len())
        .any(|w| w == b"libQt6Core.so" || w == b"libQt5Core.so");
    if qt_app
        && !environ
            .split(|b| *b == 0)
            .any(|kv| kv == b"QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1")
    {
        return Some(
            "Qt exposes no accessibility tree without \
             QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 in its environment; titles only",
        );
    }
    None
}

/// Log the reason a focused app has no tree, once per executable. Same-user
/// /proc only; silent when the records are unreadable.
pub fn note_ax_gap(data_dir: &Path, exe: &str, pid: u32) {
    if pid == 0 || exe.is_empty() {
        return;
    }
    {
        let seen = AX_GAP_LOGGED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
        let mut seen = match seen.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if !seen.insert(exe.to_lowercase()) {
            return;
        }
    }
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
    let maps = std::fs::read(format!("/proc/{pid}/maps")).unwrap_or_default();
    let Some(hint) = ax_gap_hint(exe, &cmdline, &environ, &maps) else {
        return;
    };
    let line = format!("ax-gap {exe} (pid {pid}): {hint}\n");
    eprint!("[second-brain] {line}");
    let log = data_dir.join("desktop.log");
    let _ = std::fs::create_dir_all(log.parent().unwrap_or(Path::new(".")));
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(line.as_bytes())
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_plain() {
        assert_eq!(unquote_xprop("hello world"), "hello world");
    }

    #[test]
    fn gap_hint_flags_unflagged_chromium() {
        let cmd = b"chrome\0--ozone-platform=wayland\0";
        let hint = ax_gap_hint("chrome", cmd, b"PATH=/usr/bin\0", b"");
        assert!(hint.unwrap().contains("--force-renderer-accessibility"));
    }

    #[test]
    fn gap_hint_silent_when_flag_present() {
        let cmd = b"chrome\0--force-renderer-accessibility\0";
        assert!(ax_gap_hint("chrome", cmd, b"", b"").is_none());
    }

    #[test]
    fn gap_hint_spots_electron_renderer_by_cmdline() {
        let cmd = b"discord\0--type=renderer\0--enable-features=X\0";
        let hint = ax_gap_hint("discord", cmd, b"", b"");
        assert!(hint.unwrap().contains("Chromium/Electron"));
    }

    #[test]
    fn gap_hint_flags_qt_without_env_switch() {
        let env = b"QT_QPA_PLATFORM=xcb\0PATH=/usr/bin\0";
        let maps = b"7f0000-7f1000 r--p 00000000 /usr/lib/libQt6Core.so.6.9.1\n";
        let hint = ax_gap_hint("keepassxc", b"keepassxc\0", env, maps);
        assert!(hint.unwrap().contains("QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1"));
    }

    #[test]
    fn gap_hint_ignores_session_qt_vars_in_gtk_app() {
        // QT_QPA_PLATFORM is session-inherited; only a linked Qt counts.
        let env = b"QT_QPA_PLATFORM=wayland\0WAYLAND_DISPLAY=wayland-1\0";
        assert!(ax_gap_hint("ghostty", b"ghostty\0", env, b"").is_none());
    }

    #[test]
    fn gap_hint_silent_for_plain_gtk_app() {
        assert!(ax_gap_hint("ghostty", b"ghostty\0", b"WAYLAND_DISPLAY=wayland-1\0", b"").is_none());
    }

    #[test]
    fn unquotes_escapes_and_octal() {
        // xprop octal for U+00E9 (é) in UTF-8, plus escaped quotes.
        assert_eq!(unquote_xprop("caf\\303\\251 \\\"x\\\""), "café \"x\"");
        assert_eq!(unquote_xprop("a\\\"b\\\\c"), "a\"b\\c");
    }

    #[test]
    fn splits_xprop_lines() {
        let (n, v) = split_xprop_line("_NET_WM_PID(CARDINAL) = 1234").unwrap();
        assert_eq!((n, v), ("_NET_WM_PID", "1234"));
        assert!(split_xprop_line("garbage line").is_none());
    }

    #[test]
    fn collects_quoted_segments() {
        let segs = quoted_segments("\"Navigator\", \"Firefox\"");
        assert_eq!(segs, vec!["Navigator", "Firefox"]);
        assert_eq!(quoted_segments("0x1400007"), Vec::<String>::new());
    }

    #[test]
    fn sway_finds_deepest_focused() {
        let tree: serde_json::Value = serde_json::from_str(
            r#"{"nodes":[{"name":"ws","nodes":[
                {"name":"term","pid":11,"app_id":"foot","focused":false},
                {"name":"page","pid":22,"app_id":"firefox","focused":true}]}]}"#,
        )
        .unwrap();
        let mut best = None;
        sway_focused(&tree, &mut best);
        assert_eq!(
            best,
            Some(("page".to_string(), 22, "firefox".to_string(), false))
        );
    }

    #[test]
    fn sway_reports_fullscreen_mode() {
        let tree: serde_json::Value = serde_json::from_str(
            r#"{"nodes":[{"name":"game","pid":7,"app_id":"game","focused":true,"fullscreen_mode":1}]}"#,
        )
        .unwrap();
        let mut best = None;
        sway_focused(&tree, &mut best);
        assert_eq!(
            best,
            Some(("game".to_string(), 7, "game".to_string(), true))
        );
    }

    #[test]
    fn hypr_fullscreen_only_when_exclusive() {
        let v: serde_json::Value = serde_json::from_str(r#"{"fullscreen":1}"#).unwrap();
        assert!(!hypr_fullscreen(&v));
        let v: serde_json::Value = serde_json::from_str(r#"{"fullscreen":2}"#).unwrap();
        assert!(hypr_fullscreen(&v));
        let v: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(!hypr_fullscreen(&v));
    }

    #[test]
    fn niri_parses_focused_window() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"id":5,"workspace_id":2,"title":"editor","app_id":"ghostty","pid":4242,"is_fullscreen":false}"#,
        )
        .unwrap();
        assert_eq!(
            parse_niri_window(&v),
            Some(("editor".to_string(), 4242, "ghostty".to_string(), false))
        );
    }

    #[test]
    fn niri_rejects_null_and_pidless() {
        let v: serde_json::Value = serde_json::from_str("null").unwrap();
        assert!(parse_niri_window(&v).is_none());
        let v: serde_json::Value =
            serde_json::from_str(r#"{"title":"x","pid":0}"#).unwrap();
        assert!(parse_niri_window(&v).is_none());
    }

    #[test]
    fn gnome_parses_eval_reply() {
        let reply = r#"{"t":"Files","p":5150,"c":"org.gnome.Nautilus","f":true}"#;
        assert_eq!(
            parse_gnome_focus(true, reply),
            Some((
                "Files".to_string(),
                5150,
                "org.gnome.Nautilus".to_string(),
                true
            ))
        );
    }

    #[test]
    fn gnome_rejects_failed_eval_and_null() {
        assert!(parse_gnome_focus(false, "whatever").is_none());
        assert!(parse_gnome_focus(true, "null").is_none());
        assert!(parse_gnome_focus(true, "not json").is_none());
    }

    #[test]
    fn x11_fullscreen_needs_exact_atom() {
        assert!(has_fullscreen_atom(
            "_NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_FULLSCREEN"
        ));
        assert!(!has_fullscreen_atom("_NET_WM_STATE_MAXIMIZED_VERT"));
        assert!(!has_fullscreen_atom(""));
    }

    #[test]
    fn finish_rejects_empty_title() {
        assert!(finish("   ".into(), 1, "x").is_none());
    }
}
