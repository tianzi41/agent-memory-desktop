// http-bridge.mjs — MCP HTTP(streamable) 桥进程管理
// 用途：豆包「自定义连接器」等只支持服务器 URL 的客户端（无 stdio 入口）接入。
// 与 stdio 桥（mcp_agent_memory.py）共用同一份工具定义，端口 8410，端点 /mcp。
// 生命周期跟 web 服务绑定：web 起它起，web 死它死（watchdog 拉 web 时自动重建）。
import { spawn } from "node:child_process";
import { existsSync, openSync, statSync, renameSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PORT = 8410;

let bridgeProc = null;

function pythonExe() {
  const bundled = path.join(ROOT, "runtime", "python", "python.exe");
  return existsSync(bundled) ? bundled : "python";
}

function openLogAppend(p) {
  try {
    if (existsSync(p) && statSync(p).size > 10 * 1024 * 1024) renameSync(p, p + ".1");
  } catch { /* 轮转失败不致命 */ }
  return openSync(p, "a");
}

export function httpBridgeRunning() {
  return !!(bridgeProc && bridgeProc.exitCode === null);
}

export async function startHttpBridge() {
  if (httpBridgeRunning()) return { started: false, reused: true };
  const script = path.join(ROOT, "bridge", "mcp_http_bridge.py");
  if (!existsSync(script)) return { started: false, error: "bridge 脚本缺失" };
  const out = openLogAppend(path.join(ROOT, "logs", "http-bridge.log"));
  bridgeProc = spawn(pythonExe(), [script], {
    stdio: ["ignore", out, out],
    windowsHide: true,
    // Windows 上重定向的 python stdout 默认用 GBK：中文日志变乱码，非 GBK 字符的
    // traceback 甚至在日志 handler 内抛 UnicodeEncodeError。强制 UTF-8。
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  bridgeProc.on("error", (e) => { console.error("[http-bridge] spawn error:", String(e.message || e)); bridgeProc = null; });
  bridgeProc.on("exit", () => { bridgeProc = null; });
  // 轮询等待端口就绪（uvicorn 起服务约 1-3s；上限 10s）
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: "{}",
        signal: AbortSignal.timeout(1000),
      });
      if (res.status > 0) return { started: true, healthy: true };
    } catch { /* 未就绪，继续等 */ }
  }
  return { started: true, healthy: false };
}

export function stopHttpBridge() {
  if (httpBridgeRunning()) {
    try { bridgeProc.kill(); } catch { /* 已退出则忽略 */ }
    bridgeProc = null;
    return true;
  }
  return false;
}
