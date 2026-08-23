# test-uninstall-regression.ps1
# ---------------------------------------------------------------------------
# Regression test: assert that the DSH Desktop NSIS uninstaller NEVER deletes
# the npm global directory (%APPDATA%\npm) or the global `dsh` CLI shims, so
# uninstalling the desktop shell can never break the CLI.
#
# Usage:
#   pwsh -NoProfile -File scripts/test-uninstall-regression.ps1 [-NsiPath <path>]
#
# Exits 0 on pass, 1 on assertion failure, 2 if the NSI script is missing.
# ---------------------------------------------------------------------------

param(
    [string]$NsiPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $NsiPath) {
    $NsiPath = Join-Path $root "src-tauri\target\release\nsis\x64\installer.nsi"
}

if (-not (Test-Path -LiteralPath $NsiPath)) {
    Write-Host "ERROR: NSI script not found: $NsiPath" -ForegroundColor Red
    Write-Host "       Run `npx tauri build` first." -ForegroundColor Red
    exit 2
}

$lines = Get-Content -LiteralPath $NsiPath
$content = Get-Content -LiteralPath $NsiPath -Raw

$script:failures = @()

function Assert([bool]$condition, [string]$message) {
    if ($condition) {
        Write-Host "  [PASS] $message" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] $message" -ForegroundColor Red
        $script:failures += $message
    }
}

Write-Host "Uninstall CLI-isolation regression test"
Write-Host "  target: $NsiPath"
Write-Host ""

# --- 1. Bundle id is the app's own id, never the npm directory -------------
$bundleLine = $lines | Where-Object { $_ -match '^\s*!define\s+BUNDLEID\s+"([^"]+)"' } | Select-Object -First 1
if ($bundleLine) {
    $bundleId = ($bundleLine -replace '^\s*!define\s+BUNDLEID\s+"([^"]+)".*$', '$1')
}
else {
    $bundleId = $null
}
Assert ($null -ne $bundleId) "BUNDLEID is defined"
Assert ($bundleId -ne 'npm') "BUNDLEID ('$bundleId') is not the npm dir"
Assert ($bundleId -eq 'com.dsh.desktop') "BUNDLEID is the app's own id (com.dsh.desktop)"

# --- 2. No file/dir deletion may ever reference the npm global dir ----------
$delKeyword = '(RmDir|RMDir|Delete)\b'
$npmDelete = @($lines | Where-Object { $_ -match $delKeyword -and $_ -match 'npm' })
Assert ($npmDelete.Count -eq 0) "no RmDir/RMDir/Delete references the npm dir"
foreach ($l in $npmDelete) { Write-Host "      offending: $l" -ForegroundColor Red }

# --- 3. 'Delete app data' is scoped to `${BUNDLEID}` only -------------------
$appdataDelete = @($lines | Where-Object { $_ -match 'RmDir\s+/r\s+"\$APPDATA' -or $_ -match 'RmDir\s+/r\s+"\$LOCALAPPDATA' })
$badAppdata = @($appdataDelete | Where-Object { $_ -notmatch '\$\{BUNDLEID\}' })
Assert ($badAppdata.Count -eq 0) "app-data deletion targets `${BUNDLEID} only"
foreach ($l in $badAppdata) { Write-Host "      offending: $l" -ForegroundColor Red }

# --- 4. CLI-isolation hook is wired into the generated script ---------------
if ($content -match 'installer-hooks\.nsh') {
    Write-Host "  [PASS] installer-hooks.nsh (CLI isolation guard) is wired in" -ForegroundColor Green
}
else {
    Write-Host "  [WARN] installer-hooks.nsh not present in generated script" -ForegroundColor Yellow
}

Write-Host ""
if ($script:failures.Count -gt 0) {
    Write-Host "RESULT: FAIL ($($script:failures.Count) assertion(s) failed)" -ForegroundColor Red
    exit 1
}

Write-Host "RESULT: PASS - uninstaller never touches the npm dir or dsh CLI" -ForegroundColor Green
exit 0
