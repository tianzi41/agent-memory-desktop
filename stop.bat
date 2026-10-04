@echo off
rem AgentMemory Desktop stop: write .stopped sentinel (watchdog respects it) ->
rem gracefully stop Web UI -> WAIT for ports to release -> force-kill leftovers only.
rem NOTE: keep this file ASCII-only - cmd.exe reads .bat in the local codepage (GBK);
rem non-ASCII bytes get mangled and can break lines.
setlocal enabledelayedexpansion
set ROOT=%~dp0

rem 1) Sentinel: watchdog.ps1 skips relaunch while this file exists;
rem    launcher.ps1 deletes it when the app is really started again.
echo stop> "%ROOT%.stopped"

rem 2) Graceful stop: Web UI also stops kernel (8420) and http-bridge (8410).
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:8430/api/shutdown' -Method Post -TimeoutSec 5 | Out-Null; echo Stopped. } catch { echo Not running. }"

rem 3) Wait up to 10s for ports to release BEFORE force-killing: the old version
rem    taskkill'd right after the 5s HTTP timeout - if /api/shutdown was still
rem    winding down, SIGKILL landed mid SQLite WAL checkpoint (torn db).
rem    8430 included on purpose: a hung Web left alive with the sentinel written
rem    means watchdog never relaunches - half-dead app, only Task Manager saves you.
set PORTS=8420 8410 8430
for /l %%N in (1,1,10) do (
  set ANY=0
  for %%P in (%PORTS%) do (
    netstat -ano | findstr /r /c:":%%P .*LISTENING" >nul 2>&1 && set ANY=1
  )
  if !ANY!==0 goto released
  timeout /t 1 /nobreak >nul
)
:released
for %%P in (%PORTS%) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    echo Killing leftover on port %%P ^(PID %%I^)
    taskkill /PID %%I /F >nul 2>&1
  )
)

echo Done. Watchdog stays down until the app is started again.
endlocal
rem Explicit exit code: findstr/netstat errorlevel in the loop above must not
rem leak into the batch result (measured 0 in both PS and double-click, pin it)
exit /b 0
