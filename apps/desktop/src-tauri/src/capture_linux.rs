//! Linux foreground-window + idle detection.
//!
//! No X11/Wayland client libraries: probe the compositor in order
//! Hyprland -> Sway -> X11 (xprop) -> xdotool, each shelled out with a hard
//! timeout so a dead compositor socket can never stall the capture thread.
//! std + serde_json only.
#![cfg(target_os = "linux")]

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const CMD_TIMEOUT: Duration = Duration::from_secs(2);

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

fn hyprland_active() -> Option<(String, u32, String)> {
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_err()
        && which("hyprctl").is_none()
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
    Some((title, pid, class))
}

fn sway_focused(node: &serde_json::Value, best: &mut Option<(String, u32, String)>) {
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
                // Deepest focused node wins: overwrite as we descend.
                *best = Some((name.to_string(), pid as u32, app));
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

fn sway_active() -> Option<(String, u32, String)> {
    if std::env::var("SWAYSOCK").is_err() && which("swaymsg").is_none() {
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

fn x11_active() -> Option<(String, u32, String)> {
    if std::env::var("DISPLAY").is_err() && std::env::var("WAYLAND_DISPLAY").is_err() {
        return None;
    }
    let root = run_fast("xprop", &["-root", "_NET_ACTIVE_WINDOW"])?;
    // `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1400007`
    let id = root.split('#').nth(1)?.trim().to_string();
    if id == "0x0" {
        return None;
    }
    let props = run_fast("xprop", &["-id", &id, "_NET_WM_PID", "_NET_WM_NAME", "WM_NAME", "WM_CLASS"])?;
    let mut pid = 0u32;
    let mut net_name: Option<String> = None;
    let mut wm_name: Option<String> = None;
    let mut class = String::new();
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
            _ => {}
        }
    }
    let title = net_name.or(wm_name).unwrap_or_default();
    Some((title, pid, class))
}

fn xdotool_active() -> Option<(String, u32, String)> {
    let title = run_fast("xdotool", &["getactivewindow", "getwindowname"])?;
    let pid = run_fast("xdotool", &["getactivewindow", "getwindowpid"])
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    // No class available; /proc gives exe/app, else fall back to title-derived.
    Some((title, pid, String::new()))
}

fn which(prog: &str) -> Option<String> {
    let out = run_fast("which", &[prog])?;
    let first = out.lines().next()?.trim().to_string();
    if first.is_empty() || !Path::new(&first).exists() {
        None
    } else {
        Some(first)
    }
}

/// (window_title, exe_name, app), mirroring the Windows/macOS shape.
pub fn foreground_window_info() -> Option<(String, String, String)> {
    if let Some((title, pid, class)) = hyprland_active() {
        return finish(title, pid, &class);
    }
    if let Some((title, pid, app)) = sway_active() {
        return finish(title, pid, &app);
    }
    if let Some((title, pid, class)) = x11_active() {
        return finish(title, pid, &class);
    }
    if let Some((title, pid, class)) = xdotool_active() {
        return finish(title, pid, &class);
    }
    None
}

pub fn foreground_pid() -> Option<u32> {
    if let Some((_, pid, _)) = hyprland_active() {
        return Some(pid);
    }
    if let Some((_, pid, _)) = sway_active() {
        return Some(pid);
    }
    if let Some((_, pid, _)) = x11_active() {
        return Some(pid);
    }
    None
}

/// Milliseconds-since-input via xprintidle (X11/XWayland). 0 when unavailable,
/// which disables idle suppression but keeps capture running.
pub fn idle_seconds() -> u32 {
    run_fast("xprintidle", &[])
        .and_then(|s| s.parse::<u64>().ok())
        .map(|ms| (ms / 1000).min(u32::MAX as u64) as u32)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_plain() {
        assert_eq!(unquote_xprop("hello world"), "hello world");
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
            Some(("page".to_string(), 22, "firefox".to_string()))
        );
    }

    #[test]
    fn finish_rejects_empty_title() {
        assert!(finish("   ".into(), 1, "x").is_none());
    }
}
