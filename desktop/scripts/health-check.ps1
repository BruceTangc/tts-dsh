param(
    [string]$Url = "http://127.0.0.1:3080/",
    [int]$TimeoutSec = 60,
    [int]$IntervalMs = 500
)

<#
.SYNOPSIS
Poll the DSH backend until it serves the Web UI, or the timeout elapses.

.DESCRIPTION
Repeatedly probes $Url with detect-dsh.ps1's real readiness check (HTTP 200 +
__DSH_BOOT__), exiting 0 the moment the backend is ready and 1 on timeout.

.EXAMPLE
.\health-check.ps1
.\health-check.ps1 -Url "http://127.0.0.1:8080/" -TimeoutSec 30
#>

$start = Get-Date
$deadline = $start.AddSeconds($TimeoutSec)

while ((Get-Date) -lt $deadline) {
    $result = & "$PSScriptRoot\detect-dsh.ps1" -Url $Url 2>$null
    if ($result -eq "READY: $Url") {
        $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
        Write-Output "READY: $Url (after ${elapsed}s)"
        exit 0
    }
    Start-Sleep -Milliseconds $IntervalMs
}

Write-Output "TIMEOUT: $Url not ready within ${TimeoutSec}s"
exit 1
