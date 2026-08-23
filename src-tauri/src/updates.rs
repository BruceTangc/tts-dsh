//! Update/version check for DSH Desktop and the DSH Runtime.
//!
//! V1.2 scope is check-only: fetch the latest version from the official source
//! (GitHub Releases for the Runtime, a configurable URL for the Desktop) and
//! compare it against the installed version. No download / install / rollback /
//! background upgrade. A network failure returns an error string and never
//! affects desktop startup or the backend.
//!
//! Wired to the Settings "Updates" section via a Tauri command (PHASE 5); until
//! then the helpers are intentionally inert.
#![allow(dead_code)]

use serde::Deserialize;
use std::time::Duration;

/// Official DSH Runtime release source (GitHub Releases API).
pub const RUNTIME_LATEST_URL: &str =
    "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/latest";

/// One checked version pair.
#[derive(Debug, Clone)]
pub struct VersionStatus {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
}

/// Shape of a GitHub Releases API `latest` response (only the tag is read).
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

/// Check `current` against the latest version served by `latest_url` (a GitHub
/// Releases API endpoint). Returns a `VersionStatus` on success, or an error
/// string when the network is unavailable or the response is malformed.
pub fn check_version(current: &str, latest_url: &str) -> Result<VersionStatus, String> {
    let latest = fetch_latest_tag(latest_url)?;
    Ok(VersionStatus {
        current: current.to_string(),
        latest: latest.clone(),
        update_available: is_newer(&latest, current),
    })
}

/// Fetch and normalize the latest release tag from a GitHub API JSON response.
fn fetch_latest_tag(url: &str) -> Result<String, String> {
    let resp = ureq::get(url)
        .set("User-Agent", "dsh-desktop")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("network error: {e}"))?;
    let body = resp.into_string().map_err(|e| format!("read error: {e}"))?;
    let release: GitHubRelease =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    Ok(release.tag_name.trim_start_matches(['v', 'V']).to_string())
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
