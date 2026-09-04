//! macOS ambient capture via Accessibility (AXUIElement) + CG idle.
//! Replaces Win32 window APIs and WinRT OCR with real text from the AX tree.

#![cfg(target_os = "macos")]

use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use std::ffi::c_void;
use std::ptr;

type AXUIElementRef = *mut c_void;
type AXError = i32;
const K_AX_ERROR_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFTypeRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_sec: f32) -> AXError;
    static kAXTrustedCheckOptionPrompt: CFTypeRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: u32, event_type: u32) -> f64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(theArray: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(theArray: CFTypeRef, idx: isize) -> *const c_void;
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

/// `AXValueGetType` constants for the two geometry types we read.
const K_AX_VALUE_CG_POINT: u32 = 1;
const K_AX_VALUE_CG_SIZE: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXValueGetType(value: CFTypeRef) -> u32;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
}

const K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE: u32 = 1;
const K_CG_ANY_INPUT_EVENT_TYPE: u32 = !0u32;

fn ax_copy_attr(element: AXUIElementRef, attr: &str) -> Option<CFTypeRef> {
    if element.is_null() {
        return None;
    }
    let key = CFString::new(attr);
    let mut out: CFTypeRef = ptr::null();
    let err =
        unsafe { AXUIElementCopyAttributeValue(element, key.as_CFTypeRef(), &mut out) };
    if err != K_AX_ERROR_SUCCESS || out.is_null() {
        return None;
    }
    Some(out)
}

fn cf_to_string(cf: CFTypeRef) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    unsafe {
        if CFGetTypeID(cf) != CFStringGetTypeID() {
            CFRelease(cf);
            return None;
        }
        let s = CFString::wrap_under_create_rule(cf as *const _);
        Some(s.to_string())
    }
}

fn ax_attr_string(element: AXUIElementRef, attr: &str) -> Option<String> {
    let raw = ax_copy_attr(element, attr)?;
    cf_to_string(raw)
}

/// Screen rect of an element, in points. `None` when the app exposes no
/// geometry (many web views only answer for laid-out nodes).
fn ax_frame(element: AXUIElementRef) -> Option<(f64, f64)> {
    let pos_raw = ax_copy_attr(element, "AXPosition")?;
    let mut pos = CGPoint::default();
    let ok_pos = unsafe {
        let ok = AXValueGetType(pos_raw) == K_AX_VALUE_CG_POINT
            && AXValueGetValue(
                pos_raw,
                K_AX_VALUE_CG_POINT,
                &mut pos as *mut CGPoint as *mut c_void,
            ) != 0;
        CFRelease(pos_raw);
        ok
    };
    if !ok_pos {
        return None;
    }

    let size_raw = ax_copy_attr(element, "AXSize")?;
    let mut size = CGSize::default();
    let ok_size = unsafe {
        let ok = AXValueGetType(size_raw) == K_AX_VALUE_CG_SIZE
            && AXValueGetValue(
                size_raw,
                K_AX_VALUE_CG_SIZE,
                &mut size as *mut CGSize as *mut c_void,
            ) != 0;
        CFRelease(size_raw);
        ok
    };
    if !ok_size || size.width <= 0.0 {
        return None;
    }
    Some((pos.x, size.width))
}

/// Copy rule: the returned element is owned — the caller must CFRelease it.
fn ax_attr_element(element: AXUIElementRef, attr: &str) -> Option<AXUIElementRef> {
    let raw = ax_copy_attr(element, attr)?;
    Some(raw as AXUIElementRef)
}

/// Children of `element`, each retained. The caller must CFRelease every entry.
///
/// CFArrayGetValueAtIndex is a Get-rule call, so the items are owned by the
/// array. Releasing the array can free them, which left the walk recursing
/// into dangling AXUIElementRefs and trapping inside _AXUIElementValidate.
/// Retaining each child before dropping the array keeps them alive.
fn ax_children(element: AXUIElementRef) -> Vec<AXUIElementRef> {
    let Some(raw) = ax_copy_attr(element, "AXChildren") else {
        return Vec::new();
    };
    unsafe {
        if CFGetTypeID(raw) != CFArrayGetTypeID() {
            CFRelease(raw);
            return Vec::new();
        }
        let n = CFArrayGetCount(raw);
        let mut out = Vec::with_capacity(n.max(0) as usize);
        for i in 0..n {
            let item = CFArrayGetValueAtIndex(raw, i);
            if !item.is_null() {
                CFRetain(item as CFTypeRef);
                out.push(item as AXUIElementRef);
            }
        }
        CFRelease(raw);
        out
    }
}

/// Prompt once (System Settings → Privacy → Accessibility) if not trusted.
pub fn ensure_accessibility_prompt() {
    let prompt_key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt as *const _) };
    let true_v = CFBoolean::true_value();
    let opts = CFDictionary::from_CFType_pairs(&[(prompt_key.as_CFType(), true_v.as_CFType())]);
    unsafe {
        let _ = AXIsProcessTrustedWithOptions(opts.as_CFTypeRef());
    }
}

pub fn is_accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

fn frontmost_app() -> Option<objc2::rc::Retained<NSRunningApplication>> {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    unsafe { ws.frontmostApplication() }
}

/// `(title, exe_or_bundle_id, app_name)` — bundle id goes in `exe` so blocklists
/// and the `second-brain` self-check keep working (`com.local.second-brain`).
pub fn foreground_window_info() -> Option<(String, String, String)> {
    let app = frontmost_app()?;
    let pid = unsafe { app.processIdentifier() };
    let app_name = unsafe {
        app.localizedName()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".into())
    };
    let bundle = unsafe {
        app.bundleIdentifier()
            .map(|s| s.to_string())
            .unwrap_or_else(|| app_name.clone())
    };

    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return Some((String::new(), bundle, app_name));
    }
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(ax_app, 0.2);
    }
    enable_electron_ax(ax_app);

    let title = ax_attr_element(ax_app, "AXFocusedWindow")
        .and_then(|win| {
            let t = ax_attr_string(win, "AXTitle");
            unsafe {
                CFRelease(win as CFTypeRef);
            }
            t
        })
        .unwrap_or_default();

    unsafe {
        CFRelease(ax_app as CFTypeRef);
    }

    Some((title, bundle, app_name))
}

pub fn foreground_pid() -> Option<u32> {
    let app = frontmost_app()?;
    let pid = unsafe { app.processIdentifier() };
    if pid <= 0 {
        None
    } else {
        Some(pid as u32)
    }
}

pub fn idle_seconds() -> u32 {
    let secs = unsafe {
        CGEventSourceSecondsSinceLastEventType(
            K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE,
            K_CG_ANY_INPUT_EVENT_TYPE,
        )
    };
    if secs.is_finite() && secs > 0.0 {
        secs.min(u32::MAX as f64) as u32
    } else {
        0
    }
}

/// Chromium-based apps hide their AX tree until an assistive client opts in,
/// and they watch two different attributes:
///
/// - `AXManualAccessibility` — Electron's opt-in (Slack, VS Code, Discord).
/// - `AXEnhancedUserInterface` — what VoiceOver sets; Google Chrome gates
///   renderer (web page) accessibility on this one.
///
/// Setting only the Electron key left Chrome exposing its browser furniture —
/// tab titles, "New tab", "Tab search" — and no page content at all.
fn enable_electron_ax(ax_app: AXUIElementRef) {
    let true_v = CFBoolean::true_value();
    for key in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        let k = CFString::new(key);
        unsafe {
            let _ = AXUIElementSetAttributeValue(
                ax_app,
                k.as_CFTypeRef(),
                true_v.as_CFTypeRef(),
            );
        }
    }
}

// Web content sits far deeper than native view hierarchies — a Telegram Web
// message bubble is ~20 levels down — so a 12-level cap never reached it.
const MAX_DEPTH: u32 = 28;
const MAX_NODES: u32 = 4000;
const MAX_CHARS: usize = 8_000;

/// Collect visible text from a specific process's window.
///
/// Needed because our own widget is alwaysOnTop: when it holds focus the
/// observation is still attributed to the app the user was last in, so the
/// text has to be read from that pid. Reading the frontmost app instead
/// captured the widget's own UI and filed it under the other app's name.
/// `chat` turns on bubble-direction marking: right-aligned message text is
/// prefixed with `You: `.
///
/// The AX tree exposes no sender for a chat message — direction is drawn, not
/// labelled — so without this the extractor had to guess from the words, and
/// "I will …" reads the same whoever wrote it. That guess is what turned the
/// other person's commitment into the user's own task.
pub fn window_text_for_pid(pid: i32, chat: bool) -> Option<String> {
    if !is_accessibility_trusted() || pid <= 0 {
        return None;
    }
    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return None;
    }
    unsafe {
        // 0.2s was dropping replies from Chrome once renderer accessibility is
        // on; this is a per-message ceiling, not a per-walk cost.
        let _ = AXUIElementSetMessagingTimeout(ax_app, 1.0);
    }
    enable_electron_ax(ax_app);

    let mut parts: Vec<String> = Vec::new();
    let mut nodes = 0u32;
    // A backgrounded app reports no AXFocusedWindow, so fall back to its main window.
    let win = ax_attr_element(ax_app, "AXFocusedWindow")
        .or_else(|| ax_attr_element(ax_app, "AXMainWindow"));
    if let Some(win) = win {
        // Split the window down the middle: a bubble whose centre sits right of
        // it is outgoing. Without geometry the marker is simply omitted, and
        // direction stays honestly unknown downstream.
        let center = if chat {
            ax_frame(win).map(|(x, w)| x + w / 2.0)
        } else {
            None
        };
        walk_ax(win, 0, &mut parts, &mut nodes, center);
        unsafe {
            CFRelease(win as CFTypeRef);
        }
    }
    unsafe {
        CFRelease(ax_app as CFTypeRef);
    }

    let mut text = String::new();
    for p in parts {
        let t = p.trim();
        if t.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(t);
        if text.len() >= MAX_CHARS {
            break;
        }
    }
    if text.trim().len() < 8 {
        return None;
    }
    Some(text.chars().take(MAX_CHARS).collect())
}

fn walk_ax(
    el: AXUIElementRef,
    depth: u32,
    out: &mut Vec<String>,
    nodes: &mut u32,
    pane_center_x: Option<f64>,
) {
    if depth > MAX_DEPTH || *nodes >= MAX_NODES || el.is_null() {
        return;
    }
    *nodes += 1;

    let role = ax_attr_string(el, "AXRole").unwrap_or_default();
    if matches!(
        role.as_str(),
        "AXScrollBar"
            | "AXSplitter"
            | "AXToolbar"
            | "AXMenuBar"
            | "AXMenu"
            | "AXMenuItem"
            // Chrome's tab strip and its hover cards leak other tabs' titles
            // ("Pull requests · … - Memory usage - 415 MB") into chat text.
            | "AXTabGroup"
            | "AXTabButton"
    ) {
        return;
    }

    let outgoing = pane_center_x.is_some_and(|center| {
        role == "AXStaticText"
            && ax_frame(el).is_some_and(|(x, w)| x + w / 2.0 > center)
    });

    let mut collected = false;
    for attr in ["AXValue", "AXTitle", "AXDescription", "AXHelp"] {
        if let Some(s) = ax_attr_string(el, attr) {
            let t = s.trim();
            if t.len() >= 2 {
                if outgoing {
                    out.push(format!("You: {t}"));
                } else {
                    out.push(t.to_string());
                }
                collected = true;
                if attr == "AXValue" {
                    break;
                }
            }
        }
    }
    if collected && matches!(role.as_str(), "AXStaticText" | "AXTextField" | "AXTextArea") {
        return;
    }

    // Every child is retained by ax_children, so each one is released here —
    // including the tail we skip once the node budget is spent.
    for child in ax_children(el) {
        if *nodes < MAX_NODES {
            walk_ax(child, depth + 1, out, nodes, pane_center_x);
        }
        unsafe {
            CFRelease(child as CFTypeRef);
        }
    }
}

/// Diagnostic tree walk with no role filtering and no depth pruning, so the
/// real shape of an app's AX tree is visible. Records roles and text *lengths*
/// only — never the text itself — plus a match flag for BRAIN_AX_DUMP_PHRASE.
fn ax_dump_walk(el: AXUIElementRef, depth: u32, nodes: &mut u32, out: &mut String, phrase: &str) {
    if depth > 16 || *nodes > 4000 || el.is_null() {
        return;
    }
    *nodes += 1;
    let role = ax_attr_string(el, "AXRole").unwrap_or_else(|| "?".to_string());
    let subrole = ax_attr_string(el, "AXSubrole").unwrap_or_default();
    let mut attrs: Vec<String> = Vec::new();
    let mut matched = false;
    for attr in ["AXValue", "AXTitle", "AXDescription", "AXHelp"] {
        if let Some(s) = ax_attr_string(el, attr) {
            let t = s.trim();
            if !t.is_empty() {
                attrs.push(format!("{}:{}", attr, t.chars().count()));
                if !phrase.is_empty() && t.to_lowercase().contains(phrase) {
                    matched = true;
                }
            }
        }
    }
    let kids = ax_children(el);
    out.push_str(&format!(
        "{:indent$}{}{} [{}] kids={}{}\n",
        "",
        role,
        if subrole.is_empty() {
            String::new()
        } else {
            format!("/{subrole}")
        },
        attrs.join(","),
        kids.len(),
        if matched { "  <<< PHRASE" } else { "" },
        indent = (depth * 2) as usize
    ));
    for child in kids {
        ax_dump_walk(child, depth + 1, nodes, out, phrase);
        unsafe {
            CFRelease(child as CFTypeRef);
        }
    }
}

/// Append a target process's AX tree to <data_dir>/ax-dump.log.
/// Enabled by the presence of <data_dir>/ax-dump.on, whose contents (if any)
/// are used as the phrase to flag in the tree.
pub fn dump_ax_tree(pid: i32, label: &str) {
    if !is_accessibility_trusted() || pid <= 0 {
        return;
    }
    let phrase = std::fs::read_to_string(crate::core::data_dir().join("ax-dump.on"))
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return;
    }
    // Generous timeout: this is diagnosis, not the hot capture path.
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(ax_app, 5.0);
    }
    enable_electron_ax(ax_app);

    let mut out = format!("\n=== {label} | pid {pid} ===\n");
    let win = ax_attr_element(ax_app, "AXFocusedWindow")
        .map(|w| ("AXFocusedWindow", w))
        .or_else(|| ax_attr_element(ax_app, "AXMainWindow").map(|w| ("AXMainWindow", w)));
    match win {
        Some((src, w)) => {
            out.push_str(&format!("window via {src}\n"));
            let mut nodes = 0u32;
            ax_dump_walk(w, 0, &mut nodes, &mut out, &phrase);
            out.push_str(&format!("total nodes: {nodes}\n"));
            unsafe {
                CFRelease(w as CFTypeRef);
            }
        }
        None => out.push_str("no AXFocusedWindow and no AXMainWindow\n"),
    }
    // App-level window list, in case the focused/main window is not the one with content.
    if let Some(raw) = ax_copy_attr(ax_app, "AXWindows") {
        unsafe {
            if CFGetTypeID(raw) == CFArrayGetTypeID() {
                out.push_str(&format!("AXWindows count: {}\n", CFArrayGetCount(raw)));
            }
            CFRelease(raw);
        }
    }
    unsafe {
        CFRelease(ax_app as CFTypeRef);
    }

    let path = crate::core::data_dir().join("ax-dump.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = f.write_all(out.as_bytes());
    }
}

/// Open System Settings → Privacy → Accessibility (best-effort).
pub fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}
