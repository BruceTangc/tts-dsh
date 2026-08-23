//! Windows desktop integration: single instance, `dsh://` protocol registration,
//! and activation of an already-running window.
//!
//! Implemented with the `windows` crate directly (the `single-instance` /
//! `deep-link` Tauri plugins are not vendored in this offline toolchain), so the
//! surface is kept deliberately small and defensive: every failure falls back to
//! "first instance" / no-op rather than crashing the desktop.

use std::env;

/// Named mutex identifying the single running Desktop instance.
const MUTEX_NAME: &str = "DSHDesktop_SingleInstance_Mutex";

/// Window title used to find the already-running Desktop window.
const WINDOW_TITLE: &str = "DSH";

/// Acquire the single-instance mutex.
///
/// Returns `true` when this process is the first instance (and holds the mutex
/// for the process lifetime), `false` when another instance is already running.
/// Any Windows error fails open (treated as "first instance") so the desktop
/// still starts.
pub fn acquire_single_instance() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = MUTEX_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    let Ok(handle) = (unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) }) else {
        return true; // fail open
    };
    let first = unsafe { GetLastError() } != ERROR_ALREADY_EXISTS;
    if first {
        // Hold the mutex handle for the whole process lifetime (leak it so it is
        // never closed, regardless of whether HANDLE later gains a Drop impl).
        let _ = Box::leak(Box::new(handle));
    } else {
        let _ = unsafe { CloseHandle(handle) };
    }
    first
}

/// Bring the already-running Desktop window to the foreground (restoring it if
/// minimized). A no-op when the window cannot be found.
pub fn activate_existing_window() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    let title: Vec<u16> = WINDOW_TITLE.encode_utf16().chain(std::iter::once(0)).collect();
    let Ok(hwnd) = (unsafe { FindWindowW(PCWSTR::null(), PCWSTR(title.as_ptr())) }) else {
        return;
    };
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = ShowWindow(hwnd, if IsIconic(hwnd).as_bool() { SW_RESTORE } else { SW_SHOW });
        let _ = SetForegroundWindow(hwnd);
    }
}

/// Register the `dsh://` URL protocol under `HKCU\Software\Classes\dsh` so that
/// navigating to `dsh://open` launches this executable (with the URL as `%1`).
/// Best-effort: a failed registration is silently ignored (the desktop still runs).
pub fn register_dsh_protocol() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(exe) = env::current_exe() else { return };
    let command = format!("\"{}\" \"%1\"", exe.to_string_lossy());

    let _ = (|| -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (dsh, _) = hkcu.create_subkey(r"Software\Classes\dsh")?;
        dsh.set_value("", &"URL:dsh protocol")?;
        dsh.set_value("URL Protocol", &"")?;
        let (cmd, _) = dsh.create_subkey(r"shell\open\command")?;
        cmd.set_value("", &command)?;
        Ok(())
    })();
}

/// Return the first `dsh://…` URL from the process arguments, if any (Windows
/// passes the clicked protocol URL as a command-line argument).
pub fn dsh_url_from_args() -> Option<String> {
    env::args().find(|arg| arg.starts_with("dsh://"))
}
