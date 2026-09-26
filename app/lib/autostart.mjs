// autostart.mjs — 开机自启 + watchdog 管理（UI 按钮可开关）
// 原理：启动文件夹放一个 vbs（隐藏窗口跑 watchdog.ps1）；
// watchdog 每 30s 检查 8430 端口，挂了（如 TRAE 更新杀进程）就用 launcher.ps1 -NoBrowser 拉起。
// PS 命令一律经临时 .ps1 文件执行，规避 cmd→powershell 多层引号转义问题。
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WATCHDOG_PS1 = path.join(ROOT, "watchdog.ps1");
const TRAY_PS1 = path.join(ROOT, "tray.ps1");
const STARTUP_DIR = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const VBS_NAME = "AgentMemory-Watchdog.vbs";
const VBS_PATH = path.join(STARTUP_DIR, VBS_NAME);

const VBS_CONTENT = `' AgentMemory launcher: watchdog + tray icon (created by AgentMemory Desktop, safe to delete)\n` +
  `CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${WATCHDOG_PS1}""", 0, False\n` +
  `CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${TRAY_PS1}""", 0, False\n`;

function runPs(script) {
  const tmp = path.join(os.tmpdir(), `amd-ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  writeFileSync(tmp, script, "utf8");
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: "utf8" }).trim();
  } finally {
    rmSync(tmp, { force: true });
  }
}

// 常驻助手进程（watchdog / tray）查询与启停
const HELPERS = ["watchdog.ps1", "tray.ps1"];
const listHelper = (name) => `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match '${name}' })`;

// app 文件夹被移动后 VBS 里的旧路径失效（开机自启静默失效）——web 启动时对比，不等则重写
export function repairAutostartPath() {
  if (!existsSync(VBS_PATH)) return false;
  try {
    const cur = readFileSync(VBS_PATH, "utf8");
    if (cur.includes(WATCHDOG_PS1) && cur.includes(TRAY_PS1)) return false;
  } catch { /* 读失败就当需要重写 */ }
  writeFileSync(VBS_PATH, VBS_CONTENT, "utf8");
  return true;
}

export function autostartStatus() {
  const running = {};
  for (const h of HELPERS) {
    try { running[h] = (Number(runPs(`${listHelper(h)}.Count`)) || 0) > 0; }
    catch { running[h] = false; }
  }
  return {
    enabled: existsSync(VBS_PATH),
    vbsPath: VBS_PATH,
    watchdogRunning: running["watchdog.ps1"],
    trayRunning: running["tray.ps1"],
  };
}

export function setAutostart(enable) {
  if (enable) {
    writeFileSync(VBS_PATH, VBS_CONTENT, "utf8");
    killHelpers();
    for (const p of [WATCHDOG_PS1, TRAY_PS1]) {
      const q = p.replaceAll("'", "''");
      runPs(`Start-Process powershell -ArgumentList @('-NoProfile','-WindowStyle Hidden','-ExecutionPolicy','Bypass','-File','${q}')`);
    }
    return autostartStatus();
  }
  rmSync(VBS_PATH, { force: true });
  killHelpers();
  return autostartStatus();
}

function killHelpers() {
  for (const h of HELPERS) {
    try {
      runPs(`${listHelper(h)} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    } catch { /* 进程不存在时忽略 */ }
  }
}
