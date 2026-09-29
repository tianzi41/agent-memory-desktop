# launcher.ps1 - AgentMemory Desktop launcher (ASCII only for PS 5.1 compatibility)
param([switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = 8430
$url = "http://127.0.0.1:$port"

# Node: prefer bundled portable runtime, fallback to system node
$nodeExe = Join-Path $root "runtime\node\node.exe"
if (-not (Test-Path $nodeExe)) { $nodeExe = "node" }

function Test-PortListening($p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

# Already running: just open browser
if (Test-PortListening $port) {
    Write-Host "[AgentMemory] Web UI is already running at $url" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $url }
    exit 0
}

if (Test-PortListening 8420) {
    Write-Host "[AgentMemory] Note: port 8420 busy - an external Gateway may be running." -ForegroundColor Yellow
}

# 清除停止哨兵：再次启动意味着看门狗恢复管辖权
$stoppedFlag = Join-Path $root ".stopped"
if (Test-Path $stoppedFlag) { Remove-Item $stoppedFlag -Force }

Write-Host "[AgentMemory] starting Web UI on $url ..." -ForegroundColor Cyan
$server = Join-Path $root "app\server.mjs"

$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "web.log"
# Web 日志轮换：内核/bridge 有 10MB 轮转，web.log 曾完全无界增长
foreach ($lf in @($logFile, "$logFile.err")) {
    if ((Test-Path $lf) -and (Get-Item $lf).Length -gt 10MB) {
        Move-Item $lf "$lf.1" -Force
    }
}

$proc = Start-Process -FilePath $nodeExe -ArgumentList "`"$server`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

# Wait up to 20s for the server
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 800
    if (Test-PortListening $port) { $ok = $true; break }
    if ($proc.HasExited) { break }
}

if ($ok) {
    Write-Host "[AgentMemory] ready." -ForegroundColor Green
    if (-not $NoBrowser) {
        Write-Host "[AgentMemory] opening browser..." -ForegroundColor Green
        Start-Process $url
    }
} else {
    Write-Host "[AgentMemory] FAILED to start. See logs\web.log" -ForegroundColor Red
    if (Test-Path "$logFile.err") { Get-Content "$logFile.err" -Tail 20 }
    exit 1
}
