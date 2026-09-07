//! On-screen text over AT-SPI: the Linux counterpart to macOS Accessibility.
//!
//! Reads the focused application's accessibility tree through the session's
//! AT-SPI bus (blocking D-Bus; no async runtime) and returns its visible
//! text. Pixels are never captured. Toolkits expose trees only when session
//! accessibility is enabled — see `ensure_session_accessibility` in
//! `capture_linux`, which the engine calls at startup.
#![cfg(target_os = "linux")]

use atspi_proxies::accessible::AccessibleProxyBlocking as Accessible;
use atspi_proxies::bus::BusProxyBlocking as A11yBus;
use atspi_proxies::common::{Interface, InterfaceSet};
use atspi_proxies::text::TextProxyBlocking as AxText;
use std::time::{Duration, Instant};
use zbus::blocking::Connection as BlockingConnection;
use zbus::blocking::fdo::DBusProxy as SessionBus;
use zbus::names::BusName;

const MAX_NODES: usize = 2500;
const MAX_DEPTH: usize = 40;
const MAX_CHARS: usize = 20_000;
const WALK_BUDGET: Duration = Duration::from_secs(10);

fn accessible<'x>(
    conn: &'x BlockingConnection,
    bus: &'x str,
    path: &'x str,
) -> Option<Accessible<'x>> {
    Accessible::builder(conn)
        .destination(bus)
        .ok()?
        .path(path)
        .ok()?
        .build()
        .ok()
}

/// A connection to the dedicated accessibility bus.
fn open_a11y_bus() -> Option<BlockingConnection> {
    let session = BlockingConnection::session().ok()?;
    let addr = A11yBus::builder(&session)
        .destination("org.a11y.Bus")
        .ok()?
        .path("/org/a11y/bus")
        .ok()?
        .build()
        .ok()?
        .get_address()
        .ok()
        .filter(|a| !a.is_empty())?;
    zbus::blocking::connection::Builder::address(addr.as_str())
        .ok()?
        .build()
        .ok()
}

/// Long-lived reader: one AT-SPI connection reused across polls.
pub struct AxReader {
    a11y: BlockingConnection,
}

impl AxReader {
    pub fn open() -> Option<Self> {
        Some(Self {
            a11y: open_a11y_bus()?,
        })
    }

    /// Bus names of apps currently on the registry.
    fn app_refs(&self) -> Vec<(String, String)> {
        let root = accessible(
            &self.a11y,
            "org.a11y.atspi.Registry",
            "/org/a11y/atspi/accessible/root",
        );
        let children = root.and_then(|r| r.get_children().ok()).unwrap_or_default();
        children
            .iter()
            .filter(|r| !r.is_null())
            .filter_map(|r| {
                Some((
                    r.name_as_str()?.to_string(),
                    r.path_as_str().to_string(),
                ))
            })
            .collect()
    }

    /// PID owning a bus name, via the daemon of the bus the name lives on.
    /// App names (`:1.x`) are assigned by the *accessibility* bus, whose
    /// numbering is unrelated to the session bus — resolving them against
    /// the session daemon returns other processes' PIDs.
    fn pid_of(&self, bus: &str) -> Option<u32> {
        let proxy = SessionBus::new(&self.a11y).ok()?;
        proxy
            .get_connection_unix_process_id(BusName::try_from(bus).ok()?)
            .ok()
    }

    /// Visible text of the app owning `pid`. None when the app exposes no
    /// tree (toolkit opt-in missing) or vanishes mid-walk.
    pub fn snapshot_for_pid(&self, pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        let apps = self.app_refs();
        let (bus, path) = apps
            .iter()
            .find(|(b, _)| self.pid_of(b) == Some(pid))?;
        let text = self.walk(bus, path)?.trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn walk(&self, app_bus: &str, app_path: &str) -> Option<String> {
        let mut out = String::new();
        let mut visited = 0usize;
        let mut stack = vec![(app_bus.to_string(), app_path.to_string(), 0usize)];
        let started = Instant::now();
        while let Some((bus, path, depth)) = stack.pop() {
            if visited >= MAX_NODES || out.len() >= MAX_CHARS {
                break;
            }
            if depth > MAX_DEPTH || started.elapsed() > WALK_BUDGET {
                continue;
            }
            visited += 1;
            let Some(node) = accessible(&self.a11y, &bus, &path) else {
                continue;
            };
            if let Ok(name) = node.name() {
                push_line(&mut out, &name);
            }
            // Gate Text reads on the interface set: blind GetText calls make
            // toolkits log assertion spam for every non-text node, each poll.
            let has_text = node
                .get_interfaces()
                .map(|ifaces: InterfaceSet| ifaces.contains(Interface::Text))
                .unwrap_or(false);
            if has_text {
                if let Some(text) = AxText::builder(&self.a11y)
                    .destination(bus.as_str())
                    .ok()
                    .and_then(|b| b.path(path.as_str()).ok())
                    .and_then(|b| b.build().ok())
                    .and_then(|t| t.get_text(0, -1).ok())
                {
                    push_line(&mut out, &text);
                }
            }
            if let Ok(children) = node.get_children() {
                for child in children.iter().rev() {
                    if child.is_null() {
                        continue;
                    }
                    if let (Some(name), path) =
                        (child.name_as_str(), child.path_as_str())
                    {
                        stack.push((name.to_string(), path.to_string(), depth + 1));
                    }
                }
            }
        }
        Some(out)
    }
}

fn push_line(out: &mut String, s: &str) {
    let t = s.trim();
    if t.is_empty() || out.len() + t.len() + 1 > MAX_CHARS {
        return;
    }
    // Skip a line identical to the one just pushed (trailing '\n' makes the
    // first reverse split empty, so the previous line is at index 1).
    if out.as_str().rsplit('\n').nth(1) == Some(t) {
        return;
    }
    out.push_str(t);
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::push_line;

    #[test]
    fn push_line_skips_blanks_and_repeats() {
        let mut out = String::new();
        push_line(&mut out, "  ");
        push_line(&mut out, "hello");
        push_line(&mut out, "hello");
        push_line(&mut out, "world");
        assert_eq!(out, "hello\nworld\n");
    }
}
