// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Backend configuration is resolved from fixed defaults, an optional
            // config file next to the executable, and environment overrides —
            // never from the Web UI. See backend::BackendConfig::load.
            let config = backend::BackendConfig::load();

            // Run the detection/start/health state machine off the main thread so
            // the window renders its loading page immediately instead of freezing.
            std::thread::spawn(move || match backend::ensure_backend_ready(&config) {
                Ok(url) => {
                    let handle2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(window) = handle2.get_webview_window("main") {
                            match tauri::Url::parse(&url) {
                                Ok(parsed) => {
                                    if let Err(err) = window.navigate(parsed) {
                                        eprintln!("dsh-desktop: navigate failed: {err}");
                                    }
                                }
                                Err(err) => {
                                    eprintln!("dsh-desktop: invalid backend url {url}: {err}");
                                }
                            }
                        }
                    });
                }
                Err(message) => {
                    let handle2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        eprintln!("dsh-desktop: {message}");
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
