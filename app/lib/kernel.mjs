// kernel.mjs — 内核 Gateway 进程管理（spawn + 健康检查轮询）
import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, statSync, renameSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

export function kernelDir() {
  return path.join(ROOT, "kernel", "MemoryCore");
}

export function nodeExe() {
  // 优先包内便携 Node，回退系统 Node
  const bundled = path.join(ROOT, "runtime", "node", "node.exe");
  return existsSync(bundled) ? bundled : "node";
}

export function loadAppConfig() {
  const p = path.join(ROOT, "data", "config", "app.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

let kernelProc = null;

export function kernelRunning() {
  return kernelProc && !kernelProc.killed && kernelProc.exitCode === null;
}

export async function health(timeoutMs = 4000) {
  const cfg = loadAppConfig();
  const port = cfg?.gatewayPort || 8420;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function waitHealthy(maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const h = await health();
    if (h.ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// 启动内核：若 8420 已有健康 Gateway（外部手动启动的）则直接复用
export async function startKernel() {
  const existing = await health(2000);
  if (existing.ok) return { started: false, reused: true, healthy: true };

  const cfg = loadAppConfig();
  if (!cfg) throw new Error("尚未完成首启向导（data/config/app.json 缺失）");

  const env = {
    ...process.env,
    TDAI_GATEWAY_CONFIG: path.join(ROOT, "data", "config", "tdai-gateway.local.yaml"),
    TDAI_LLM_API_KEY: cfg.apiKey,
    TDAI_LLM_BASE_URL: cfg.baseUrl,
    TDAI_LLM_MODEL: cfg.model,
  };

  const logPath = path.join(ROOT, "logs", "kernel.log");
  const out = openLogAppend(logPath);
  const err = out;

  kernelProc = spawn(nodeExe(), ["--import", "tsx", "src\\gateway\\server.ts"], {
    cwd: kernelDir(),
    env,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  // spawn 失败（node.exe 被删/路径错）会异步 emit 'error'——不监听会 throw 崩掉整个 web
  kernelProc.on("error", (e) => { console.error("[kernel] spawn error:", String(e.message || e)); kernelProc = null; });
  kernelProc.on("exit", () => { kernelProc = null; });

  const ok = await waitHealthy();
  // 超时但进程还活着（半死不活）：杀掉并置空，避免下次 startKernel 重复 spawn 导致进程堆积
  if (!ok && kernelProc && kernelProc.exitCode === null) {
    try { kernelProc.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
    kernelProc = null;
  }
  return { started: true, reused: false, healthy: ok, pid: kernelProc?.pid };
}

export function stopKernel() {
  if (kernelRunning()) {
    const p = kernelProc;
    try { p.kill("SIGTERM"); } catch { /* 已退出则忽略 */ }
    // 兜底：5s 后仍未退出（Windows 上 SIGTERM 走 TerminateProcess，通常立即生效）强杀
    setTimeout(() => { try { if (p.exitCode === null) p.kill("SIGKILL"); } catch { /* 忽略 */ } }, 5000).unref();
    return true;
  }
  return false;
}

// 日志轮转：单文件超 10MB  rename 成 .1 再开新的（保留一份历史，防无限增长）
function openLogAppend(p) {
  try {
    if (existsSync(p) && statSync(p).size > 10 * 1024 * 1024) renameSync(p, p + ".1");
  } catch { /* 轮转失败不致命，继续追加 */ }
  return openSync(p, "a");
}
