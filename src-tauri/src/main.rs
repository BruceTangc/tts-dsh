// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod platform;
mod updates;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Build the initialization script injected before any page script runs. It
/// carries the reliable Desktop-runtime flag (never User-Agent sniffing) plus the
/// current Desktop/Runtime versions, so the Web UI's thin entry layer and its
/// Settings "Updates" section can read them directly.
fn build_init_script(desktop_version: &str, runtime_version: &str) -> String {
    format!(
        "window.__DSH_DESKTOP__ = true;\
         window.__DSH_DESKTOP_VERSION__ = {desktop_version:?};\
         window.__DSH_RUNTIME_VERSION__ = {runtime_version:?};"
    )
}

/// Restore and focus the main window (used by the tray "打开 DSH" action and a
/// left-click on the tray icon). Never creates a second window or backend.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Build the system tray icon with its menu, kept alive for the process lifetime.
/// Left-click and "打开 DSH" restore the window; "退出 DSH" actually exits.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 DSH", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DSH", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                backend::log_line("tray menu open; restoring window");
                show_main_window(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                backend::log_line("tray left-click; restoring window");
                show_main_window(tray.app_handle());
            }
        });

    // Reuse the official DSH whale icon (the same one used by the window/exe).
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    // Dropping the handle removes the tray, so leak it for the process lifetime.
    std::mem::forget(tray);
    Ok(())
}

fn main() {
    if let Some(url) = platform::dsh_url_from_args() {
        backend::log_line(&format!("launched via protocol: {url}"));
    }

    // Single instance: a second launch (e.g. from `dsh://open`) activates the
    // already-running window and exits — never a second desktop, never a second
    // backend.
    if !platform::acquire_single_instance() {
        backend::log_line("another instance is running; activating it and exiting");
        if !platform::signal_activation() {
            // Event not yet created (tiny race at first launch): raw fallback.
            platform::activate_existing_window();
        }
        std::process::exit(0);
    }

    // Create the activation event so later launches can signal us to restore
    // the window through Tauri's own `show()` (keeps tao's VISIBLE flag coherent,
    // so close-to-tray keeps working after a re-open).
    let activation_event = platform::create_activation_event();

    // Self-register the dsh:// protocol (best-effort, HKCU) so the browser entry
    // page's "open desktop" button can launch us.
    platform::register_dsh_protocol();

    // Backend configuration is resolved from fixed defaults, an optional config
    // file next to the executable, and environment overrides — never from the
    // Web UI. Loaded before the window so the init script can carry versions.
    let config = backend::BackendConfig::load();
    let desktop_version = env!("CARGO_PKG_VERSION").to_string();
    let runtime_version = config
        .repo_path
        .as_deref()
        .and_then(updates::read_runtime_version)
        .unwrap_or_else(|| "unknown".to_string());
    let init_script = build_init_script(&desktop_version, &runtime_version);
    backend::log_line(&format!("desktop started; backend url {}", config.backend_url));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // Create the main window with the desktop flag injected before any
            // page script, so the Web UI reliably detects Desktop and skips the
            // browser entry page. The close (X) handler is registered on the
            // builder so it reliably applies to this dynamically created window.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DSH")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .center()
                .initialization_script(&init_script)
                .build()?;

            // Close (X) → hide to tray. Registered on the window itself so it
            // reliably applies to this dynamically created window.
            let close_handle = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    backend::log_line("close requested; hiding to tray");
                    api.prevent_close();
                    let _ = close_handle.hide();
                }
            });

            setup_tray(app)?;

            // Background thread: when a second launch signals the activation
            // event, restore the window through Tauri (never raw ShowWindow).
            if let Some(event) = activation_event {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    platform::wait_for_activation(event);
                    backend::log_line("activation event signaled; restoring window");
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || show_main_window(&h));
                });
            }

            let handle = app.handle().clone();

            // Run the detection/start/health state machine off the main thread so
            // the window renders its loading page immediately instead of freezing.
            std::thread::spawn(move || match backend::ensure_backend_ready(&config) {
                Ok(url) => {
                    let handle2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(window) = handle2.get_webview_window("main") {
                            match tauri::Url::parse(&url) {
                                Ok(parsed) => match window.navigate(parsed) {
                                    Ok(()) => backend::log_line(&format!("navigated to {url}")),
                                    Err(err) => backend::log_line(&format!("navigate failed: {err}")),
                                },
                                Err(err) => {
                                    backend::log_line(&format!("invalid backend url {url}: {err}"));
                                }
                            }
                        } else {
                            backend::log_line("window 'main' not found");
                        }
                    });
                }
                Err(message) => {
                    backend::log_line(&format!("error: {message}"));
                    let handle2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        handle2
                            .dialog()
                            .message(message)
                            .title("DSH Desktop")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                    });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
