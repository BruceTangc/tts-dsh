//! Backend lifecycle state machine for DSH Desktop.
//!
//! DSH Backend and DSH Web UI are a **single process** (`dsh web`): the backend
//! hosts the agent runtime, the `/api` HTTP + WebSocket surface, and serves the
//! built frontend `dist/` with `window.__DSH_BOOT__` injected into `index.html`.
//! "Backend ready" therefore means exactly: the Web UI URL answers HTTP 200 and
//! its body carries the `__DSH_BOOT__` boot manifest.
//!
//! State machine (V1 spec):
//!
//! ```text
//! STARTING -> CHECK_EXISTING_BACKEND
//!   |-- exists -> HEALTH_CHECK -> READY -> LOAD_WEB_UI
//!   `-- missing -> START_BACKEND -> HEALTH_CHECK -> READY -> LOAD_WEB_UI
//! ```
//!
//! Reusing an already-running backend is the first priority; only a confirmed
//! missing backend triggers a spawn. The desktop never kills a backend it did
//! not start, and (V1 policy) leaves even the one it did start running on exit.

use serde::Deserialize;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Canonical loopback URL of `dsh web` (the same page the browser loads).
const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:3080/";
/// Launcher for the backend process (production: the official `dsh` command on
/// PATH). The dev checkout mode instead runs `node` on `<repo>/apps/cli/lib/bin.js`.
const DEFAULT_START_COMMAND: &str = "dsh";
/// Fixed, whitelisted launch arguments: the web profile and `--no-open` so the
/// desktop never opens a second browser tab.
fn default_start_args_vec() -> Vec<String> {
    vec!["web".to_string(), "--no-open".to_string()]
}
/// Overall health-check deadline.
const DEFAULT_HEALTH_TIMEOUT_SEC: u64 = 60;
/// Poll interval between readiness probes.
const DEFAULT_POLL_INTERVAL_MS: u64 = 500;
/// Per-probe HTTP timeout.
const PROBE_TIMEOUT_MS: u64 = 2000;
/// Config file name looked up next to the executable.
const CONFIG_FILE_NAME: &str = "dsh-desktop.conf.json";

/// Immutable backend launch configuration. Every value resolves from a config
/// file, environment variables, or fixed defaults — never from the Web UI, so
/// the launch command stays fixed and whitelisted (V1 security requirement).
#[derive(Debug, Clone, Deserialize)]
pub struct BackendConfig {
    #[serde(default = "default_backend_url")]
    pub backend_url: String,
    #[serde(default = "default_start_command")]
    pub start_command: String,
    /// Optional dev checkout root. `None` (production) launches the `dsh`
    /// command; `Some(repo)` runs `node <repo>/apps/cli/lib/bin.js` instead.
    #[serde(default)]
    pub repo_path: Option<String>,
    #[serde(default = "default_start_args_vec")]
    pub start_args: Vec<String>,
    #[serde(default = "default_health_timeout_sec")]
    pub health_timeout_sec: u64,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
}

fn default_backend_url() -> String {
    DEFAULT_BACKEND_URL.to_string()
}
fn default_start_command() -> String {
    DEFAULT_START_COMMAND.to_string()
}
fn default_health_timeout_sec() -> u64 {
    DEFAULT_HEALTH_TIMEOUT_SEC
}
fn default_poll_interval_ms() -> u64 {
    DEFAULT_POLL_INTERVAL_MS
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self {
            backend_url: DEFAULT_BACKEND_URL.to_string(),
            start_command: DEFAULT_START_COMMAND.to_string(),
            repo_path: None,
            start_args: default_start_args_vec(),
            health_timeout_sec: DEFAULT_HEALTH_TIMEOUT_SEC,
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
        }
    }
}

impl BackendConfig {
    /// Resolve configuration: fixed defaults, then a JSON config file (next to
    /// the executable or named by `DSH_DESKTOP_CONFIG`), then environment
    /// variables, which take highest precedence.
    pub fn load() -> Self {
        let mut config = Self::default();

        if let Some(path) = config_file_path() {
            match fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<BackendConfig>(&text) {
                    Ok(loaded) => config = loaded,
                    Err(err) => {
                        eprintln!("dsh-desktop: ignoring invalid config {}: {err}", path.display())
                    }
                },
                Err(err) => eprintln!("dsh-desktop: could not read config {}: {err}", path.display()),
            }
        }

        if let Ok(url) = env::var("DSH_BACKEND_URL") {
            if !url.is_empty() {
                config.backend_url = url;
            }
        }
        if let Ok(cmd) = env::var("DSH_BACKEND_START_COMMAND") {
            if !cmd.is_empty() {
                config.start_command = cmd;
            }
        }
        if let Ok(repo) = env::var("DSH_REPO_PATH") {
            if !repo.is_empty() {
                config.repo_path = Some(repo);
            }
        }
        if let Ok(args_json) = env::var("DSH_BACKEND_START_ARGS") {
            match serde_json::from_str::<Vec<String>>(&args_json) {
                Ok(args) => config.start_args = args,
                Err(err) => eprintln!("dsh-desktop: ignoring DSH_BACKEND_START_ARGS: {err}"),
            }
        }
        if let Ok(timeout) = env::var("DSH_BACKEND_HEALTH_TIMEOUT_SEC") {
            if let Ok(v) = timeout.parse::<u64>() {
                config.health_timeout_sec = v;
            }
        }

        config
    }
}

/// Resolve the config file path: `DSH_DESKTOP_CONFIG` if set, else the file
/// next to the running executable.
fn config_file_path() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("DSH_DESKTOP_CONFIG") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    let dir = env::current_exe().ok()?.parent()?.to_path_buf();
    Some(dir.join(CONFIG_FILE_NAME))
}

/// Resolve the log file path: `%LOCALAPPDATA%\DSH\logs\dsh-desktop.log`, created
/// on demand. Returns `None` (rather than crashing) when the directory cannot be
/// resolved or created, so logging can never fail the desktop.
fn log_file_path() -> Option<PathBuf> {
    let local = env::var("LOCALAPPDATA").ok()?;
    if local.is_empty() {
        return None;
    }
    let dir = PathBuf::from(local).join("DSH").join("logs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dsh-desktop.log"))
}

/// Append a diagnostic line to `%LOCALAPPDATA%\DSH\logs\dsh-desktop.log` and echo
/// it to stderr. Best-effort: logging must never fail the app.
pub fn log_line(msg: &str) {
    eprintln!("dsh-desktop: {msg}");
    let Some(path) = log_file_path() else { return };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{stamp} {msg}\n");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Run the startup state machine and return the ready Web UI URL.
pub fn ensure_backend_ready(config: &BackendConfig) -> Result<String, String> {
    log_line(&format!("checking for an existing backend at {}", config.backend_url));
    if probe(&config.backend_url) {
        log_line("existing backend is ready; reusing it");
        return Ok(config.backend_url.clone());
    }

    log_line(&format!(
        "no backend detected; starting one ({})",
        describe_start(config)
    ));
    let mut child = spawn_backend(config)?;
    let pid = child.id();

    let deadline = Instant::now() + Duration::from_secs(config.health_timeout_sec);
    loop {
        if probe(&config.backend_url) {
            log_line(&format!("backend (pid {pid}) is ready"));
            return Ok(config.backend_url.clone());
        }
        if Instant::now() >= deadline {
            // This child failed to become ready; it is ours to reclaim.
            let _ = child.kill();
            return Err(format!(
                "DSH backend did not become ready within {} seconds.\nStart command: {}\nURL: {}",
                config.health_timeout_sec,
                describe_start(config),
                config.backend_url,
            ));
        }
        std::thread::sleep(Duration::from_millis(config.poll_interval_ms));
    }
}

/// Probe the backend: HTTP GET the root and require a 200 whose body carries
/// the `__DSH_BOOT__` boot manifest — the real readiness signal, not a port guess.
fn probe(url: &str) -> bool {
    match ureq::get(url)
        .timeout(Duration::from_millis(PROBE_TIMEOUT_MS))
        .call()
    {
        Ok(resp) => {
            if resp.status() != 200 {
                return false;
            }
            resp.into_string()
                .map(|body| body.contains("__DSH_BOOT__"))
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Resolve the backend launch command and arguments.
///
/// Production (`repo_path == None`) launches the official `dsh` command with the
/// fixed args (`dsh web --no-open`). Dev (`repo_path == Some(repo)`) runs
/// `node <repo>/apps/cli/lib/bin.js` with the same args, failing fast with a
/// clear error when that script does not exist.
fn launch_command(config: &BackendConfig) -> Result<(String, Vec<String>), String> {
    match &config.repo_path {
        Some(repo) => {
            let script = PathBuf::from(repo).join("apps").join("cli").join("lib").join("bin.js");
            if !script.exists() {
                return Err(format!(
                    "DSH runtime not found: {}\nSet DSH_REPO_PATH to the DeepSeek Harness repository root.",
                    script.display()
                ));
            }
            let mut args = vec![script.to_string_lossy().into_owned()];
            args.extend(config.start_args.iter().cloned());
            Ok(("node".to_string(), args))
        }
        None => Ok((config.start_command.clone(), config.start_args.clone())),
    }
}

/// Human-readable description of the backend launch, for logs and errors.
fn describe_start(config: &BackendConfig) -> String {
    match launch_command(config) {
        Ok((program, args)) => {
            let mut parts = vec![program];
            parts.extend(args.iter().cloned());
            parts.join(" ")
        }
        Err(err) => err,
    }
}

/// Spawn the backend with the fixed, whitelisted command. Stdio is nulled so the
/// child survives a desktop exit without inheriting a broken pipe, and the
/// desktop intentionally never reaps it (V1: keep running on exit).
fn spawn_backend(config: &BackendConfig) -> Result<Child, String> {
    let (program, args) = launch_command(config)?;
    Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| {
            format!(
                "failed to start DSH backend ({program}): {err}\nIs the official DSH installed and on PATH?"
            )
        })
}
