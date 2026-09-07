//! Global shortcut over the XDG GlobalShortcuts portal (Wayland sessions).
//!
//! Tauri's shortcut plugin grabs keys over X11, which never fires while a
//! native Wayland window holds focus. On Wayland sessions we additionally
//! bind Ctrl+Shift+Space through `org.freedesktop.portal.GlobalShortcuts`
//! wherever a backend implements it (GNOME, KDE). Both paths share the
//! toggle debounce in `main`, so a press that reaches both still toggles
//! once. Everything here fails open: no portal, no backend, or a denied
//! bind just logs once and leaves the X11 grab as the only path.
#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;
use zbus::blocking::Connection as BlockingConnection;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

const PORTAL_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS_IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
const SHORTCUT_ID: &str = "toggle-widget";
/// GTK accelerator notation, as the portal expects for preferred_trigger.
const TRIGGER: &str = "<Control><Shift>space";

/// Token-safe sender stem: ":1.42" -> "second_brain_1_42". Portal tokens
/// must be valid object-path components (no leading ':', no dots).
fn sender_token(unique_name: &str) -> String {
    let clean: String = unique_name
        .trim_start_matches(':')
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("second_brain_{clean}")
}

fn portal_proxy<'a>(
    conn: &'a BlockingConnection,
) -> zbus::Result<zbus::blocking::Proxy<'a>> {
    zbus::blocking::Proxy::new(conn, PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE)
}

/// Wait for the portal Request Response on `path`. Runs on a dedicated
/// thread: a backend that accepts the call but never answers would park
/// `next()` forever, which must never stall app startup.
fn await_response(
    conn: &BlockingConnection,
    path: &ObjectPath<'_>,
) -> Option<HashMap<String, OwnedValue>> {
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(REQUEST_IFACE)
        .ok()?
        .member("Response")
        .ok()?
        .path(path.clone())
        .ok()?
        .build();
    let mut iter =
        zbus::blocking::MessageIterator::for_match_rule(rule, conn, Some(4)).ok()?;
    let msg = iter.next()?.ok()?;
    let (code, results): (u32, HashMap<String, OwnedValue>) =
        msg.body().deserialize().ok()?;
    (code == 0).then_some(results)
}

fn log_once(line: &str) {
    eprint!("[second-brain] portal-shortcut: {line}\n");
    let log = crate::core::data_dir().join("desktop.log");
    let _ = std::fs::create_dir_all(log.parent().unwrap_or(std::path::Path::new(".")));
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(format!("portal-shortcut: {line}\n").as_bytes())
        });
}

/// Bind Ctrl+Shift+Space through the portal, then serve Activated presses
/// for the life of the process. Call once from a spawned thread.
pub fn run(app: AppHandle) {
    if std::env::var("WAYLAND_DISPLAY").is_err() {
        return;
    }
    let conn = match BlockingConnection::session() {
        Ok(c) => c,
        Err(_) => return,
    };
    // Synchronous support probe with the normal method timeout: no
    // interface or no backend fails here instead of parking below.
    let proxy = match portal_proxy(&conn) {
        Ok(p) => p,
        Err(_) => return,
    };
    let version: u32 = match proxy.get_property::<u32>("version") {
        Ok(v) => v,
        Err(_) => {
            log_once("GlobalShortcuts portal has no backend; X11 grab only");
            return;
        }
    };
    let unique = conn
        .unique_name()
        .map(|n| n.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let stem = sender_token(&unique);

    let mut opts = HashMap::new();
    opts.insert(
        "session_handle_token".to_string(),
        Value::from(format!("{stem}_session")),
    );
    opts.insert(
        "handle_token".to_string(),
        Value::from(format!("{stem}_create")),
    );
    let req: OwnedObjectPath = match proxy.call("CreateSession", &opts) {
        Ok(r) => r,
        Err(e) => {
            log_once(&format!("CreateSession failed ({e}); X11 grab only"));
            return;
        }
    };
    let mut results = match await_response(&conn, &req) {
        Some(r) => r,
        None => {
            log_once("CreateSession unanswered; X11 grab only");
            return;
        }
    };
    let session: OwnedObjectPath = match results
        .remove("session_handle")
        .and_then(|v| OwnedObjectPath::try_from(v).ok())
    {
        Some(s) => s,
        None => {
            log_once("CreateSession gave no session; X11 grab only");
            return;
        }
    };

    let mut shortcut_opts = HashMap::new();
    shortcut_opts.insert(
        "preferred_trigger".to_string(),
        Value::from(TRIGGER),
    );
    let shortcuts = vec![(SHORTCUT_ID.to_string(), shortcut_opts)];
    let mut bind_opts = HashMap::new();
    bind_opts.insert(
        "handle_token".to_string(),
        Value::from(format!("{stem}_bind")),
    );
    let bind_req: OwnedObjectPath = match proxy.call(
        "BindShortcuts",
        &(
            &session,
            &shortcuts,
            "",
            &bind_opts,
        ),
    ) {
        Ok(r) => r,
        Err(e) => {
            log_once(&format!("BindShortcuts failed ({e}); X11 grab only"));
            return;
        }
    };
    match await_response(&conn, &bind_req) {
        Some(_) => log_once(&format!(
            "bound {TRIGGER} via portal v{version} (with X11 grab)"
        )),
        None => {
            log_once("BindShortcuts unanswered; X11 grab only");
            return;
        }
    }

    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(SHORTCUTS_IFACE)
        .ok()
        .and_then(|b| b.member("Activated").ok())
        .map(|b| b.build());
    let Some(rule) = rule else { return };
    let iter = match zbus::blocking::MessageIterator::for_match_rule(rule, &conn, Some(8)) {
        Ok(i) => i,
        Err(_) => return,
    };
    for msg in iter {
        let Ok(msg) = msg else { continue };
        let Ok((handle, id, _ts, _opts)): zbus::Result<(
            OwnedObjectPath,
            String,
            u64,
            HashMap<String, OwnedValue>,
        )> = msg.body().deserialize()
        else {
            continue;
        };
        if handle == session && id == SHORTCUT_ID {
            crate::toggle_main_debounced(&app);
        }
    }
    // Iterator ends only if the portal connection dies; the X11 grab stays.
    log_once("portal connection lost; X11 grab only");
}

/// How long a press stays claimable by either shortcut path.
pub const DEBOUNCE: Duration = Duration::from_millis(400);

#[cfg(test)]
mod tests {
    use super::{TRIGGER, sender_token};

    #[test]
    fn token_is_path_safe() {
        assert_eq!(sender_token(":1.42"), "second_brain_1_42");
        assert_eq!(sender_token(":1.2.3"), "second_brain_1_2_3");
    }

    #[test]
    fn trigger_is_gtk_notation() {
        assert!(TRIGGER.starts_with("<Control>"));
        assert!(!TRIGGER.contains('+'));
    }
}
