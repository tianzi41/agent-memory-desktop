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

$logFile = Join-Path $root "logs\watchdog.log"
function WLog($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { /* log write failure is not fatal */ }
}

WLog "[AgentMemory watchdog] started (check every 30s, port $port)"

$stoppedFlag = Join-Path $root ".stopped"

while ($true) {
    Start-Sleep -Seconds 30
    # 用户显式停过（stop.bat 写哨兵）：不拉活，直到下次真正启动（launcher 会删哨兵）
    if (Test-Path $stoppedFlag) { continue }
    if (Test-PortListening $port) { continue }

    WLog "port $port down - relaunching..."
    $launcherPath = Join-Path $root "launcher.ps1"
    # Quote the path explicitly: PS 5.1 does not auto-quote ArgumentList elements
    # containing spaces - an install path with spaces makes the inner powershell
    # fail with "file does not have a '.ps1' extension"
    Start-Process powershell -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $launcherPath), "-NoBrowser"
    ) -WindowStyle Hidden

    # #27: probe the port instead of blindly sleeping 120s - a failed relaunch
    # still costs the full window, a successful one resumes watching immediately
    $elapsed = 0
    while ($elapsed -lt 120 -and -not (Test-PortListening $port)) {
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
    WLog ("relaunch settled={0} after ~{1}s" -f (Test-PortListening $port), $elapsed)
}
