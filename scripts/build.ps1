# One-shot build: resolve cargo, build the release exe, and report its path.
# No npm/Node dependency is required for a release build — `cargo build --release`
# compiles the Rust shell and embeds dist/index.html + the icon directly.
# Run AFTER installing Rust + MSVC Build Tools (README section 6).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $root "src-tauri"

function Resolve-Cargo {
    $cmd = Get-Command cargo -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $fallback) { return $fallback }
    return $null
}

Write-Output "== 1/3 Toolchain =="
$cargo = Resolve-Cargo
if (-not $cargo) {
    Write-Error "cargo not found. Install Rust first (README section 6.1)."
    exit 1
}
Write-Output "cargo: $cargo"
& $cargo --version
try { rustc --version 2>$null } catch { Write-Warning "rustc not on PATH (not required if cargo works)." }

Write-Output ""
Write-Output "== 2/3 Build (cargo build --release) =="
Set-Location $tauriDir
& $cargo build --release
if ($LASTEXITCODE -ne 0) {
    Write-Error "cargo build failed (exit $LASTEXITCODE). See the error above; a common cause is a missing MSVC linker (README section 6.2)."
    exit 1
}

Write-Output ""
Write-Output "== 3/3 Result =="
$exe = Join-Path $tauriDir "target\release\dsh-desktop.exe"
if (Test-Path $exe) {
    Write-Output "BUILD OK: $exe"
    Write-Output "Run it directly — it reuses any running backend, or starts one."
}
else {
    Write-Error "Build finished but $exe was not found."
    exit 1
}
