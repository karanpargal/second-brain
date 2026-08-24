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
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
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

fn ax_attr_element(element: AXUIElementRef, attr: &str) -> Option<AXUIElementRef> {
    // Caller does not own Create on nested elements from Copy — they are
    // Get-rule values inside the tree; we do not CFRelease them individually.
    let raw = ax_copy_attr(element, attr)?;
    Some(raw as AXUIElementRef)
}

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

/// Electron hides its AX tree until an assistive client opts in.
fn enable_electron_ax(ax_app: AXUIElementRef) {
    let key = CFString::new("AXManualAccessibility");
    let true_v = CFBoolean::true_value();
    unsafe {
        let _ = AXUIElementSetAttributeValue(
            ax_app,
            key.as_CFTypeRef(),
            true_v.as_CFTypeRef(),
        );
    }
}

const MAX_DEPTH: u32 = 12;
const MAX_NODES: u32 = 4000;
const MAX_CHARS: usize = 8_000;

/// Walk the focused window's AX tree and collect visible text.
pub fn focused_window_text() -> Option<String> {
    if !is_accessibility_trusted() {
        return None;
    }
    let app = frontmost_app()?;
    let pid = unsafe { app.processIdentifier() };
    let ax_app = unsafe { AXUIElementCreateApplication(pid) };
    if ax_app.is_null() {
        return None;
    }
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(ax_app, 0.2);
    }
    enable_electron_ax(ax_app);

    let mut parts: Vec<String> = Vec::new();
    let mut nodes = 0u32;
    if let Some(win) = ax_attr_element(ax_app, "AXFocusedWindow") {
        walk_ax(win, 0, &mut parts, &mut nodes);
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

fn walk_ax(el: AXUIElementRef, depth: u32, out: &mut Vec<String>, nodes: &mut u32) {
    if depth > MAX_DEPTH || *nodes >= MAX_NODES || el.is_null() {
        return;
    }
    *nodes += 1;

    let role = ax_attr_string(el, "AXRole").unwrap_or_default();
    if matches!(
        role.as_str(),
        "AXScrollBar" | "AXSplitter" | "AXToolbar" | "AXMenuBar" | "AXMenu" | "AXMenuItem"
    ) {
        return;
    }

    let mut collected = false;
    for attr in ["AXValue", "AXTitle", "AXDescription", "AXHelp"] {
        if let Some(s) = ax_attr_string(el, attr) {
            let t = s.trim();
            if t.len() >= 2 {
                out.push(t.to_string());
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

    for child in ax_children(el) {
        walk_ax(child, depth + 1, out, nodes);
        if *nodes >= MAX_NODES {
            break;
        }
    }
}

/// Open System Settings → Privacy → Accessibility (best-effort).
pub fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}
