// uninstall.mjs — 卸载向导：反注入客户端 → 关开机自启 → 停内核 → （可选）删记忆数据
// 不删软件文件夹本身（web 进程正从里面运行），最后引导用户手动删除
import { existsSync, rmSync, statSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadAppConfig, stopKernel } from "./kernel.mjs";
import { removeClients, detectClients } from "./inject.mjs";
import { setAutostart, autostartStatus } from "./autostart.mjs";
import { stopHttpBridge } from "./http-bridge.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function dirSizeKB(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else total += statSync(p).size || 0;
      } catch { /* 跳过无权限项 */ }
    }
  };
  walk(dir);
  return Math.round(total / 1024);
}

// 数据目录（记忆库根）：与 backup.mjs 同源逻辑
function dataDir() {
  const cfg = loadAppConfig();
  return (cfg?.dataDir || path.join(ROOT, "data", "memory-tdai")).replaceAll("\\", "/");
}

// 卸载影响清单（不执行任何操作，供前端展示）
export function uninstallPlan() {
  const clients = detectClients();
  const clientList = [];
  for (const [id, c] of Object.entries(clients)) {
    if (!c.injectable || !c.installed) continue;
    let hasEntry = false;
    try {
      if (existsSync(c.configFile)) {
        const json = JSON.parse(readFileSync(c.configFile, "utf8"));
        hasEntry = !!(json.mcpServers && json.mcpServers["agent-memory"]);
      }
    } catch { /* 配置读失败时按"无条目"展示 */ }
    clientList.push({ id, name: c.name, configFile: c.configFile, hasEntry });
  }
  const dir = dataDir();
  let dataSizeKB = 0, dataExists = false;
  try {
    if (existsSync(dir)) { dataExists = true; dataSizeKB = dirSizeKB(dir); }
  } catch { /* 目录异常时按不存在处理 */ }
  return {
    clients: clientList,
    autostart: autostartStatus(),
    dataDir: dir,
    dataExists,
    dataSizeKB,
    appDir: ROOT,
  };
}

// 执行卸载。removeData=true 时删除整个记忆库（不可恢复）
export async function runUninstall({ removeData = false } = {}) {
  const steps = [];
  // 1. 反注入所有已安装客户端
  try {
    const results = removeClients();
    const names = Object.entries(results).map(([id, r]) => `${id}:${r.ok ? (r.removed ? "已移除" : "无条目") : "失败"}`);
    steps.push({ step: "反注入客户端 MCP 配置", ok: true, detail: names.join("，") || "无可注入客户端" });
  } catch (e) {
    steps.push({ step: "反注入客户端 MCP 配置", ok: false, detail: String(e.message || e) });
  }
  // 2. 关闭开机自启 + 杀 watchdog/tray
  try {
    setAutostart(false);
    steps.push({ step: "关闭开机自启与守护进程", ok: true, detail: "VBS 已删，watchdog/tray 已停" });
  } catch (e) {
    steps.push({ step: "关闭开机自启与守护进程", ok: false, detail: String(e.message || e) });
  }
  // 3. 停内核 + HTTP 桥
  try {
    const stopped = stopKernel();
    const bridgeStopped = stopHttpBridge();
    steps.push({ step: "停止记忆内核与 HTTP 桥", ok: true, detail: `${stopped ? "内核已停止" : "内核本就未运行"}；${bridgeStopped ? "HTTP 桥已停止" : "HTTP 桥本就未运行"}` });
  } catch (e) {
    steps.push({ step: "停止记忆内核与 HTTP 桥", ok: false, detail: String(e.message || e) });
  }
  // 4. 可选：删记忆数据（停内核后删，避免 SQLite 热删）
  if (removeData) {
    const dir = dataDir();
    try {
      if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); steps.push({ step: "删除记忆数据", ok: true, detail: dir }); }
      else steps.push({ step: "删除记忆数据", ok: true, detail: "数据目录不存在，跳过" });
    } catch (e) {
      steps.push({ step: "删除记忆数据", ok: false, detail: String(e.message || e) });
    }
  }
  return { ok: steps.every((s) => s.ok), steps, removeData, appDir: ROOT };
}
