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

/// Window title used to find the already-running Desktop window (fallback path).
const WINDOW_TITLE: &str = "DSH";

/// Named event a second launch signals so the already-running instance restores
/// its window through Tauri's own `show()` — never raw `ShowWindow`, which would
/// desync tao's cached `VISIBLE` flag and break later close-to-tray.
const ACTIVATION_EVENT_NAME: &str = "DSHDesktop_Activation_Event";

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

/// Create (first instance) the named activation event and return its raw handle
/// value, leaked for the process lifetime. Returns `None` on failure.
pub fn create_activation_event() -> Option<isize> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::CreateEventW;

    let name: Vec<u16> = ACTIVATION_EVENT_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr())) }.ok()?;
    let raw = handle.0 as isize;
    // Leak so the OS event handle stays open for the process lifetime.
    let _ = Box::leak(Box::new(handle));
    Some(raw)
}

/// Signal the named activation event so the first instance restores its window
/// through Tauri. Returns `false` if the event could not be opened (e.g. the
/// first instance has not created it yet), letting the caller fall back to the
/// raw `ShowWindow` path.
pub fn signal_activation() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};

    let name: Vec<u16> = ACTIVATION_EVENT_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let Ok(handle) = (unsafe { OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(name.as_ptr())) }) else {
        return false;
    };
    let ok = unsafe { SetEvent(handle) }.is_ok();
    unsafe {
        let _ = CloseHandle(handle);
    }
    ok
}

/// Block until the activation event is signaled. Runs on the first instance's
/// background thread; `event` is the value returned by `create_activation_event`.
pub fn wait_for_activation(event: isize) {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::WaitForSingleObject;

    unsafe {
        let _ = WaitForSingleObject(HANDLE(event as *mut core::ffi::c_void), u32::MAX);
    }
}

/// Bring the already-running Desktop window to the foreground (restoring it if
/// minimized). A no-op when the window cannot be found. This is the raw Win32
/// fallback used only when the activation event is unavailable; the preferred
/// path is `signal_activation`, which keeps Tauri's visibility state coherent.
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
