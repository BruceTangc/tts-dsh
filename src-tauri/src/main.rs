// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod platform;
mod updates;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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

/// Extra WebView2 browser arguments (Windows only). Disabling the GPU is a
/// common fix for the "web content freezes after a while, but the same page is
/// fine in a regular browser" symptom, where the WebView2 GPU process hangs.
/// Override with the `DSH_WEBVIEW2_ARGS` env var to test other flags without
/// rebuilding. The default re-includes wry's own defaults, which this call
/// otherwise replaces.
fn webview2_args() -> String {
    const DEFAULT: &str =
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";
    match std::env::var("DSH_WEBVIEW2_ARGS") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT.to_string(),
    }
}

/// Check for a newer Desktop release and, on user confirmation, download the
/// installer and run it silently, then exit. Runs on a background thread; the
/// dialogs use `blocking_show` (which must not run on the main thread).
fn run_update_flow(app: &tauri::AppHandle) {
    let current = env!("CARGO_PKG_VERSION");

    // Runtime (dsh CLI) update check — reminder only, never auto-install. Run
    // first so it is shown even when a Desktop update then downloads + exits.
    match updates::check_runtime_update() {
        Ok(r) if r.update_available => {
            backend::log_line(&format!(
                "runtime update available: {} -> {}",
                r.installed, r.latest
            ));
            let _ = app
                .dialog()
                .message(format!(
                    "Runtime（dsh）有新版本 {}（当前 {}）。\n请运行：npm install -g @deepseek-ai/dsh@latest",
                    r.latest, r.installed
                ))
                .title("DSH Runtime 更新")
                .blocking_show();
        }
        Ok(_) => {}
        Err(err) => backend::log_line(&format!("runtime update check skipped: {err}")),
    }

    let info = match updates::check_updates(current) {
        Ok(info) => info,
        Err(err) => {
            backend::log_line(&format!("update check failed: {err}"));
            let _ = app
                .dialog()
                .message(format!("检查更新失败：{err}"))
                .title("DSH Desktop")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }
    };

    if !info.update_available {
        backend::log_line(&format!("already up to date ({})", info.current));
        let _ = app
            .dialog()
            .message(format!("当前已是最新版本（{}）", info.current))
            .title("DSH Desktop 更新")
            .blocking_show();
        return;
    }

    let Some(url) = info.download_url.clone() else {
        backend::log_line("update available but no installer asset");
        let _ = app
            .dialog()
            .message(format!(
                "发现新版本 {}，但 release 里没有找到安装包（.exe）。",
                info.latest
            ))
            .title("DSH Desktop 更新")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return;
    };

    let confirmed = app
        .dialog()
        .message(format!(
            "发现新版本 {}（当前 {}），是否下载并更新？",
            info.latest, info.current
        ))
        .title("DSH Desktop 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "更新".into(),
            "取消".into(),
        ))
        .blocking_show();

    if !confirmed {
        backend::log_line("update cancelled by user");
        return;
    }

    let dest = std::env::temp_dir().join("dsh-desktop-update.exe");
    backend::log_line(&format!("downloading update from {url}"));
    if let Err(err) = updates::download_installer(&url, &dest) {
        backend::log_line(&format!("download failed: {err}"));
        let _ = app
            .dialog()
            .message(format!("下载更新失败：{err}"))
            .title("DSH Desktop")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return;
    }

    // Schedule the installer to run after a short delay (lets the desktop fully
    // exit so the installer can replace the running exe without a "close app"
    // prompt), then exit. `CREATE_NO_WINDOW` avoids a console flash.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let dest_str = dest.to_string_lossy().into_owned();
    let script = format!("timeout /t 2 /nobreak >nul && \"{dest_str}\" /S");
    backend::log_line("scheduling installer run; exiting desktop");
    let _ = std::process::Command::new("cmd")
        .args(["/C", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    app.exit(0);
}

/// Build the system tray icon with its menu, kept alive for the process lifetime.
/// Left-click and "打开 DSH" restore the window; "退出 DSH" actually exits.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 DSH", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DSH", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check_update, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                backend::log_line("tray menu open; restoring window");
                show_main_window(app);
            }
            "check_update" => {
                backend::log_line("check update requested");
                let handle = app.clone();
                std::thread::spawn(move || run_update_flow(&handle));
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
    backend::log_line(&format!("webview2 args: {}", webview2_args()));

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
                .additional_browser_args(&webview2_args())
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
