// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod platform;
mod updates;

use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
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

fn main() {
    if let Some(url) = platform::dsh_url_from_args() {
        backend::log_line(&format!("launched via protocol: {url}"));
    }

    // Single instance: a second launch (e.g. from `dsh://open`) activates the
    // already-running window and exits — never a second desktop, never a second
    // backend.
    if !platform::acquire_single_instance() {
        backend::log_line("another instance is running; activating it and exiting");
        platform::activate_existing_window();
        std::process::exit(0);
    }

    // Self-register the dsh:// protocol (best-effort, HKCU) so the browser entry
    // page's "open desktop" button can launch us.
    platform::register_dsh_protocol();

    // Backend configuration is resolved from fixed defaults, an optional config
    // file next to the executable, and environment overrides — never from the
    // Web UI. Loaded before the window so the init script can carry versions.
    let config = backend::BackendConfig::load();
    let desktop_version = env!("CARGO_PKG_VERSION").to_string();
    let runtime_version = updates::read_runtime_version(&config.repo_path)
        .unwrap_or_else(|| "unknown".to_string());
    let init_script = build_init_script(&desktop_version, &runtime_version);
    backend::log_line(&format!("desktop started; backend url {}", config.backend_url));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // Create the main window with the desktop flag injected before any
            // page script, so the Web UI reliably detects Desktop and skips the
            // browser entry page.
            let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DSH")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .center()
                .initialization_script(&init_script)
                .build()?;

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
