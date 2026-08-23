param(
    [string]$BinPath = "D:\DSH\deepseek-harness\apps\cli\lib\bin.js"
)

<#
.SYNOPSIS
Start the DSH backend (web profile) without opening a browser.

.DESCRIPTION
Launches `node <BinPath> web --no-open` detached so the process survives this
script. The command is fixed and whitelisted — only the built `dsh` CLI path and
the literal arguments `web --no-open` are ever used; no arbitrary shell input is
accepted. The desktop shell performs the same spawn from Rust.

.EXAMPLE
.\start-dsh.ps1
.\start-dsh.ps1 -BinPath "D:\DSH\deepseek-harness\apps\cli\lib\bin.js"
#>

$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $BinPath)) {
    Write-Error "dsh CLI not found: $BinPath"
    exit 1
}

$proc = Start-Process -FilePath $node `
    -ArgumentList @($BinPath, "web", "--no-open") `
    -PassThru -WindowStyle Hidden

Write-Output "STARTED: node pid=$($proc.Id) ($BinPath web --no-open)"
exit 0
