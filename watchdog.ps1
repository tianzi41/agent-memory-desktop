# watchdog.ps1 - AgentMemory watchdog: keep Web UI (port 8430) alive (ASCII only)
# Started at logon via Startup folder vbs (managed by the app UI button).
# If Web UI dies (e.g. killed by a TRAE update), relaunch it via launcher.ps1 -NoBrowser.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8430

function Test-PortListening($p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

Write-Host "[AgentMemory watchdog] started (check every 30s, port $port)"

while ($true) {
    Start-Sleep -Seconds 30
    if (Test-PortListening $port) { continue }

    Write-Host "[AgentMemory watchdog] port $port down - relaunching..."
    Start-Process powershell -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $root "launcher.ps1"), "-NoBrowser"
    ) -WindowStyle Hidden

    # give the relaunch time to settle before checking again
    Start-Sleep -Seconds 120
}
