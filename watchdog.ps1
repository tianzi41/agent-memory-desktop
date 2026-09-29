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

$stoppedFlag = Join-Path $root ".stopped"

while ($true) {
    Start-Sleep -Seconds 30
    # 用户显式停过（stop.bat 写哨兵）：不拉活，直到下次真正启动（launcher 会删哨兵）
    if (Test-Path $stoppedFlag) { continue }
    if (Test-PortListening $port) { continue }

    Write-Host "[AgentMemory watchdog] port $port down - relaunching..."
    Start-Process powershell -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $root "launcher.ps1"), "-NoBrowser"
    ) -WindowStyle Hidden

    # give the relaunch time to settle before checking again
    Start-Sleep -Seconds 120
}
