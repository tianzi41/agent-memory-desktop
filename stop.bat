@echo off
rem AgentMemory Desktop stop: stops kernel and Web UI
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:8430/api/shutdown' -Method Post -TimeoutSec 3 | Out-Null; echo Stopped. } catch { echo Not running. }"
