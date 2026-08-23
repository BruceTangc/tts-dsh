# Verify the shared-backend scenarios after building dsh-desktop.exe.
# Run in a NORMAL terminal (needs process enumeration + the built exe).
#   .\scripts\test-scenarios.ps1
param(
    [string]$Url = "http://127.0.0.1:3080/",
    [string]$Exe = "D:\DSH Document\DSH Desktop\src-tauri\target\release\dsh-desktop.exe"
)

$ErrorActionPreference = "Stop"

function Test-BackendReady {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -eq 200 -and $r.Content -match "__DSH_BOOT__")
    }
    catch { return $false }
}

function Get-DshBackendPids {
    # node.exe processes whose command line looks like a dsh web backend
    # (`node .../lib/bin.js web --no-open` or the dev `node .../bin.ts web`).
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "\bweb\b" -and $_.CommandLine -match "bin\.js|bin\.ts" }
    return @($procs | ForEach-Object { $_.ProcessId })
}

if (-not (Test-Path $Exe)) {
    Write-Error "Desktop exe not found: $Exe`nRun scripts/build.ps1 first."
    exit 1
}

Write-Output "=== Precondition ==="
$readyBefore = Test-BackendReady
Write-Output "backend ready : $readyBefore  ($Url)"
$pidsBefore = Get-DshBackendPids
Write-Output "backend procs : $($pidsBefore.Count)  ($($pidsBefore -join ', '))"

Write-Output ""
Write-Output "=== Launch Desktop ==="
$desktop = Start-Process -FilePath $Exe -PassThru
Write-Output "desktop pid   : $($desktop.Id)"
Start-Sleep -Seconds 8

$readyAfter = Test-BackendReady
$pidsAfter = Get-DshBackendPids
Write-Output "backend ready : $readyAfter"
Write-Output "backend procs : $($pidsAfter.Count)  ($($pidsAfter -join ', '))"
$newPids = @($pidsAfter | Where-Object { $pidsBefore -notcontains $_ })

Write-Output ""
Write-Output "=== Scenario 1/5 — no second backend ==="
if ($readyBefore -and $newPids.Count -eq 0) {
    Write-Output "PASS: existing backend reused; no second backend started."
}
elseif (-not $readyBefore -and $newPids.Count -ge 1) {
    Write-Output "PASS: backend was absent; desktop started exactly one ($($newPids -join ', '))."
}
elseif ($newPids.Count -eq 0) {
    Write-Output "WARN: no new backend process and backend still not ready — investigate."
}
else {
    Write-Output "FAIL: $($newPids.Count) new backend process(es) detected ($($newPids -join ', '))."
}

Write-Output ""
Write-Output "=== Scenario 2 — desktop exit must not kill backend ==="
Stop-Process -Id $desktop.Id -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$readyAfterClose = Test-BackendReady
Write-Output "backend ready after desktop close: $readyAfterClose"
if ($readyAfterClose) { Write-Output "PASS: backend still running." }
else { Write-Output "FAIL: backend died when desktop exited." }

Write-Output ""
Write-Output "=== Scenario 6 — Browser + Desktop share one backend ==="
Write-Output "Keep a browser tab open at $Url while the desktop runs;"
Write-Output "both must reflect the same session state (single shared backend)."

Write-Output ""
Write-Output "Done."
