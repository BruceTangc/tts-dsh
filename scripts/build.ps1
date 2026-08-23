# One-shot build: verify the toolchain, install deps, build, and report the exe.
# Run AFTER installing Rust + MSVC Build Tools (see README section 6).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Output "== 1/4 Toolchain =="
try {
    rustc --version
    cargo --version
}
catch {
    Write-Error "Rust toolchain not found. Install it first (README section 6.1)."
    exit 1
}

Write-Output "== 2/4 MSVC linker =="
$hasLinker = $false
if (Get-Command link.exe -ErrorAction SilentlyContinue) {
    $hasLinker = $true
}
else {
    # link.exe is usually NOT on PATH; probe the standard Build Tools location.
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vs) { $hasLinker = $true }
    }
}
if (-not $hasLinker) {
    Write-Warning "Could not confirm the MSVC linker. If the build fails with 'link.exe not found', install the VS Build Tools (README section 6.2)."
}
else {
    Write-Output "MSVC linker detected."
}

Write-Output "== 3/4 Install npm deps =="
pnpm install

Write-Output "== 4/4 Build =="
pnpm tauri build

$exe = Join-Path $root "src-tauri\target\release\dsh-desktop.exe"
if (Test-Path $exe) {
    Write-Output ""
    Write-Output "BUILD OK: $exe"
    Write-Output "Run it directly (it reuses any running backend, or starts one)."
}
else {
    Write-Error "Build finished but $exe was not found."
    exit 1
}
