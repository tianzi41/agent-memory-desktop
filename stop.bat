@echo off
rem AgentMemory Desktop stop: write .stopped sentinel (watchdog respects it) ->
rem gracefully stop Web UI -> port-based fallback kill of orphaned kernel/bridge.
rem NOTE: keep this file ASCII-only - cmd.exe reads .bat in the local codepage (GBK);
rem non-ASCII bytes get mangled and can break lines.
setlocal
set ROOT=%~dp0

rem 1) Sentinel: watchdog.ps1 skips relaunch while this file exists;
rem    launcher.ps1 deletes it when the app is really started again.
echo stop> "%ROOT%.stopped"

rem 2) Graceful stop: Web UI also stops kernel (8420) and http-bridge (8410).
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:8430/api/shutdown' -Method Post -TimeoutSec 5 | Out-Null; echo Stopped. } catch { echo Not running. }"

rem 3) Fallback: if Web UI already died, its children may survive as orphans (Windows
rem    spawn has no kill-on-close Job Object). Kill ONLY the PIDs owning ports 8420/8410,
rem    never by process name. /c: is mandatory - without it findstr treats the space as a
rem    pattern separator and ".*LISTENING" alone matches EVERY listening line.
for %%P in (8420 8410) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    echo Killing orphan on port %%P ^(PID %%I^)
    taskkill /PID %%I /F >nul 2>&1
  )
)

echo Done. Watchdog stays down until the app is started again.
endlocal
