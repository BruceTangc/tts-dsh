//! Update check + self-update for DSH Desktop.
//!
//! The desktop checks its own GitHub Releases (`DESKTOP_LATEST_URL`) for a newer
//! version and, on user confirmation, downloads the installer asset and runs it
//! silently to replace the current build. The DSH Runtime is check-only: the
//! desktop never touches the `dsh` CLI.
//!
//! All network work happens off the main thread; any failure returns an error
//! string and never affects startup or the backend.

use serde::Deserialize;
use std::time::Duration;

/// Official DSH Desktop release source (this repo's GitHub Releases).
pub const DESKTOP_LATEST_URL: &str =
    "https://api.github.com/repos/BruceTangc/tts-dsh/releases/latest";

/// Official DSH Runtime (`dsh` CLI) latest version on the npm registry — the
/// official, recommended update channel.
pub const RUNTIME_NPM_LATEST_URL: &str =
    "https://registry.npmjs.org/@deepseek-ai/dsh/latest";

/// One checked update: current vs latest version + the installer download URL.
#[derive(Debug, Clone)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
    pub download_url: Option<String>,
}

/// Shape of a GitHub Releases API `latest` response.
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// Check `current` (the desktop version) against the latest Desktop release.
/// Returns the latest version, whether it is newer, and the `.exe` installer
/// download URL (if one is attached to the release).
pub fn check_updates(current: &str) -> Result<UpdateInfo, String> {
    let release = fetch_release(DESKTOP_LATEST_URL)?;
    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let download_url = release
        .assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
        .map(|a| a.browser_download_url.clone());
    Ok(UpdateInfo {
        current: current.to_string(),
        latest: latest.clone(),
        update_available: is_newer(&latest, current),
        download_url,
    })
}

/// GET `url` with retry and backoff. GitHub/npm can be flaky (the connection
/// is sometimes reset mid-TLS-handshake), so retry a few times before giving up.
fn get_string(url: &str, accept: &str, attempts: u32) -> Result<String, String> {
    let mut last_err = String::new();
    for attempt in 0..attempts {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(500 * attempt as u64));
        }
        match ureq::get(url)
            .set("User-Agent", "dsh-desktop")
            .set("Accept", accept)
            .timeout(Duration::from_secs(15))
            .call()
        {
            Ok(resp) => return resp.into_string().map_err(|e| format!("read error: {e}")),
            Err(e) => last_err = format!("network error: {e}"),
        }
    }
    Err(last_err)
}

/// Fetch the latest release JSON from a GitHub Releases API endpoint.
fn fetch_release(url: &str) -> Result<GitHubRelease, String> {
    let body = get_string(url, "application/vnd.github+json", 4)?;
    serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))
}

/// Download the installer from `url` to `dest` (a local file path). Streams the
/// response so a large installer is not buffered in memory.
pub fn download_installer(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let resp = ureq::get(url)
        .set("User-Agent", "dsh-desktop")
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|e| format!("download error: {e}"))?;
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| format!("create error: {e}"))?;
    std::io::copy(&mut reader, &mut file).map_err(|e| format!("write error: {e}"))?;
    Ok(())
}

/// Runtime (`dsh` CLI) update status: installed vs latest npm version.
#[derive(Debug, Clone)]
pub struct RuntimeUpdateInfo {
    pub installed: String,
    pub latest: String,
    pub update_available: bool,
}

/// Shape of the npm registry `…/latest` response (only the version is read).
#[derive(Deserialize)]
struct NpmLatest {
    version: String,
}

/// Check the installed `dsh` CLI version against the latest on npm. Fails with
/// an error string when `dsh` is not installed or the registry is unreachable.
pub fn check_runtime_update() -> Result<RuntimeUpdateInfo, String> {
    let installed = installed_dsh_version()?;
    let latest = fetch_npm_latest(RUNTIME_NPM_LATEST_URL)?;
    Ok(RuntimeUpdateInfo {
        installed: installed.clone(),
        latest: latest.clone(),
        update_available: is_newer(&latest, &installed),
    })
}

/// Read the installed `dsh` version by running `cmd /C dsh --version`.
fn installed_dsh_version() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("cmd")
        .args(["/C", "dsh", "--version"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("dsh --version 失败：{e}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("dsh 未安装（`dsh --version` 无输出）".to_string());
    }
    Ok(text)
}

/// Fetch the latest version from the npm registry `…/latest` endpoint.
fn fetch_npm_latest(url: &str) -> Result<String, String> {
    let body = get_string(url, "application/json", 4)?;
    let latest: NpmLatest = serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    Ok(latest.version)
}

/// Read the installed Runtime version from `<repo_path>/package.json`.
pub fn read_runtime_version(repo_path: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }
    let path = std::path::Path::new(repo_path).join("package.json");
    let text = std::fs::read_to_string(path).ok()?;
    let manifest: Manifest = serde_json::from_str(&text).ok()?;
    Some(manifest.version)
}

/// Whether `latest` is newer than `current`, comparing the numeric dotted prefix
/// (pre-release / build suffixes are ignored for ordering).
fn is_newer(latest: &str, current: &str) -> bool {
    version_tuple(latest) > version_tuple(current)
}

fn version_tuple(s: &str) -> Vec<u64> {
    s.trim_start_matches(['v', 'V'])
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}
