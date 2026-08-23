param(
    [string]$Url = "http://127.0.0.1:3080/"
)

<#
.SYNOPSIS
Detect whether the DSH backend is running and serving the Web UI.

.DESCRIPTION
The DSH backend and Web UI are one process (`dsh web`). Readiness is proven
only when GET $Url returns HTTP 200 and the body carries the `__DSH_BOOT__`
boot manifest — the same probe the desktop shell uses. This is a real health
check, not a port guess and not a blind sleep.

.EXAMPLE
.\detect-dsh.ps1
# exits 0 when ready, 1 otherwise
#>

$ErrorActionPreference = "Stop"
try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200 -and $resp.Content -match "__DSH_BOOT__") {
        Write-Output "READY: $Url"
        exit 0
    }
    Write-Output "NOT_READY: $Url (HTTP $($resp.StatusCode), no __DSH_BOOT__)"
    exit 1
}
catch {
    Write-Output "NOT_READY: $Url ($($_.Exception.Message))"
    exit 1
}
