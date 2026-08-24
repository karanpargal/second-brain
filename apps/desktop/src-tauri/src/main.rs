// No console window on Windows (debug or release) — closing a console would kill the widget.
#![windows_subsystem = "windows"]

mod capture;
mod core;
#[cfg(target_os = "macos")]
mod capture_mac;

use capture::{CaptureEngine, CaptureStatus};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
use tauri_plugin_autostart::MacosLauncher;

struct AppState {
    engine: Arc<CaptureEngine>,
}

#[tauri::command]
fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    state.engine.status()
}

#[tauri::command]
fn pause_capture(state: State<'_, AppState>, minutes: u64) -> CaptureStatus {
    state.engine.pause_for_minutes(minutes);
    state.engine.status()
}

#[tauri::command]
fn resume_capture(state: State<'_, AppState>) -> CaptureStatus {
    state.engine.resume();
    state.engine.status()
}

#[tauri::command]
fn core_base_url() -> String {
    core::core_url()
}

#[tauri::command]
fn api_token() -> Result<String, String> {
    core::api_token().ok_or_else(|| "api-token not found — is the core running?".into())
}

#[tauri::command]
fn set_widget_mode(app: AppHandle, compact: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let _ = win.set_shadow(false);
    if compact {
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 72.0,
            height: 72.0,
        }));
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 400.0,
            height: 680.0,
        }));
    }
    // park near bottom-right after resize
    if let Ok(Some(m)) = win.current_monitor() {
        let scale = m.scale_factor();
        let size = m.size();
        let w = if compact { 72.0 } else { 400.0 };
        let h = if compact { 72.0 } else { 680.0 };
        let x = (size.width as f64 / scale) - w - 24.0;
        let y = if compact {
            (size.height as f64 / scale) - h - 24.0
        } else {
            48.0
        };
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: x.max(8.0),
            y: y.max(8.0),
        }));
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, pinned: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    win.set_always_on_top(pinned)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_widget(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    core::stop_core_if_owned();
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        capture_mac::open_accessibility_settings();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
fn prompt_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        capture_mac::ensure_accessibility_prompt();
        Ok(capture_mac::is_accessibility_trusted())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn place_bottom_right(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(Some(m)) = win.current_monitor() {
            let scale = m.scale_factor();
            let size = m.size();
            let w = 400.0;
            let x = (size.width as f64 / scale) - w - 24.0;
            let y = 48.0;
            let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: x.max(8.0),
                y,
            }));
        }
    }
}

/// Allow microphone for the local core widget (Cartesia push-to-talk).
#[cfg(windows)]
fn allow_widget_microphone(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|webview| {
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            },
            PermissionRequestedEventHandler,
        };

        unsafe {
            let controller = webview.controller();
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };

            let mut token = 0i64;
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = Default::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    });
}

#[cfg(not(windows))]
fn allow_widget_microphone(_win: &tauri::WebviewWindow) {}

/// Percent-encode so an HTML string can ride inside a `data:` URL that
/// `tauri::Url::parse` accepts (spaces, quotes, and `<`/`>` would break it).
fn pct(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                o.push(*b as char)
            }
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

fn data_html(body: &str) -> String {
    format!("data:text/html,{}", pct(body))
}

/// Shown the instant the window opens so the shell is never a blank, frozen
/// "Not Responding" rectangle while the core cold-starts.
fn loading_url() -> String {
    data_html(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0f;color:#e5e7eb;
font-family:system-ui,Segoe UI,sans-serif}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:14px}
.spinner{width:22px;height:22px;border:2px solid #3f3f46;border-top-color:#818cf8;
border-radius:50%;animation:spin 0.8s linear infinite}
.t{font-size:13px;color:#a1a1aa}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap"><div class="spinner"></div>
<div class="t">Starting Second Brain...</div></div></body></html>"#,
    )
}

fn error_url() -> String {
    data_html(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0f;color:#e5e7eb;
font-family:system-ui,Segoe UI,sans-serif}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:12px;padding:24px;text-align:center}
.t{font-size:13px;color:#a1a1aa;line-height:1.5}
button{margin-top:6px;padding:8px 16px;border:0;border-radius:8px;
background:#4f46e5;color:#fff;font-size:13px;cursor:pointer}
</style></head><body><div class="wrap">
<div class="t">Second Brain's local engine did not start in time.<br>
It may still be warming up.</div>
<button onclick="location.reload()">Retry</button>
</div></body></html>"#,
    )
}

fn main() {
    let engine = Arc::new(CaptureEngine::new());
    engine.start();
    let engine_for_setup = engine.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            engine: engine.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            capture_status,
            pause_capture,
            resume_capture,
            core_base_url,
            api_token,
            set_widget_mode,
            set_always_on_top,
            hide_widget,
            quit_app,
            open_accessibility_settings,
            prompt_accessibility
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                // Menu-bar / tray app — no Dock icon (mirrors skipTaskbar on Windows).
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                capture_mac::ensure_accessibility_prompt();
            }

            // Paint an immediate loading screen so the shell is responsive while
            // the core (possibly a cold tsx compile) comes up on a background
            // thread. Blocking here is what caused the "Not Responding" window.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_shadow(false);
                let _ = win.set_always_on_top(true);
                let _ = win.set_decorations(false);
                if let Ok(url) = loading_url().parse::<tauri::Url>() {
                    let _ = win.navigate(url);
                }
                place_bottom_right(app.handle());
                allow_widget_microphone(&win);
            }

            let show_i = MenuItem::with_id(app, "show", "Show widget", true, None::<&str>)?;
            let pause_i =
                MenuItem::with_id(app, "pause", "Pause capture 1h", true, None::<&str>)?;
            let resume_i =
                MenuItem::with_id(app, "resume", "Resume capture", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &pause_i, &resume_i, &quit_i])?;

            let engine_tray = engine_for_setup.clone();
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Second Brain widget")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "pause" => {
                        engine_tray.pause_for_minutes(60);
                    }
                    "resume" => {
                        engine_tray.resume();
                    }
                    "quit" => {
                        core::stop_core_if_owned();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            {
                let notify_app = app.handle().clone();
                let notify_tray = _tray.clone();
                std::thread::spawn(move || {
                    let dir = core::data_dir();
                    let path = dir.join("pending-notifications.json");
                    let mut last_sig = String::new();
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let Ok(raw) = std::fs::read_to_string(&path) else {
                            continue;
                        };
                        if raw == last_sig {
                            continue;
                        }
                        last_sig = raw.clone();
                        let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok();
                        let items = parsed
                            .as_ref()
                            .and_then(|v| v.get("items"))
                            .and_then(|i| i.as_array())
                            .cloned()
                            .unwrap_or_default();
                        if items.is_empty() {
                            continue;
                        }
                        let first = items.first();
                        let title = first
                            .and_then(|n| n.get("title"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("Second Brain")
                            .to_string();
                        let body = first
                            .and_then(|n| n.get("body"))
                            .and_then(|b| b.as_str())
                            .unwrap_or("Reminder")
                            .to_string();
                        let _ = notify_tray.set_tooltip(Some(&format!("Second Brain — {body}")));
                        let app = notify_app.clone();
                        let toast_title = title.clone();
                        let toast_body = body.clone();
                        let _ = notify_app.run_on_main_thread(move || {
                            use tauri_plugin_notification::NotificationExt;
                            let _ = app
                                .notification()
                                .builder()
                                .title(&toast_title)
                                .body(&toast_body)
                                .show();
                        });
                        show_main(&notify_app);
                    }
                });
            }

            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                let app_handle = app.handle().clone();
                app.global_shortcut().on_shortcut(
                    shortcut,
                    move |_app, _s, event| {
                        if event.state == ShortcutState::Pressed {
                            toggle_main(&app_handle);
                        }
                    },
                )?;
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // Bring the core up off the main thread; navigate to the real widget
            // (served same-origin by the core, so token injection works) once it
            // is healthy, otherwise show a retry page.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = core::ensure_core_running();
                if let Err(ref e) = result {
                    eprintln!("[second-brain] core start: {e}");
                    let log = core::data_dir().join("desktop.log");
                    let _ =
                        std::fs::create_dir_all(log.parent().unwrap_or(std::path::Path::new(".")));
                    let line = format!(
                        "{} core start failed: {e}\n",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs().to_string())
                            .unwrap_or_else(|_| "?".into())
                    );
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log)
                        .and_then(|mut f| {
                            use std::io::Write;
                            f.write_all(line.as_bytes())
                        });
                }

                let ok = result.is_ok();
                let target = if ok {
                    format!("{}/widget?v=20260823d", core::core_url())
                } else {
                    error_url()
                };
                let handle = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    if let Some(win) = handle.get_webview_window("main") {
                        if let Ok(url) = target.parse::<tauri::Url>() {
                            let _ = win.navigate(url);
                        } else {
                            let _ = win
                                .eval(&format!(r#"window.location.replace("{}");"#, target));
                        }
                        allow_widget_microphone(&win);
                    }
                });
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
