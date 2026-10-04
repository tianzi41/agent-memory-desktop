// kernel.mjs — 内核 Gateway 进程管理（spawn + 健康检查轮询）
import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync, statSync, renameSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

export function kernelDir() {
  return path.join(ROOT, "kernel", "MemoryCore");
}

export function nodeExe() {
  // 调试/测试可用 TDAI_NODE_EXE 指定 node（#46 的 spawn 失败快路径验证也靠它）
  if (process.env.TDAI_NODE_EXE && existsSync(process.env.TDAI_NODE_EXE)) return process.env.TDAI_NODE_EXE;
  // 优先包内便携 Node，回退系统 Node
  const bundled = path.join(ROOT, "runtime", "node", "node.exe");
  return existsSync(bundled) ? bundled : "node";
}

export function loadAppConfig() {
  const p = path.join(ROOT, "data", "config", "app.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // 写入中途崩溃会留下截断的 app.json；解析失败不能向上抛——
    // 否则每次读配置都异常，启动 IIFE 未处理拒绝 → 进程崩 → 看门狗拉 → 再崩的死循环。
    // 返回 null 让 UI 回到"未完成向导"状态，用户重新保存一次即可恢复。
    console.error("[kernel] app.json 解析失败（可能上次写入被截断），请到设置页重新保存配置");
    return null;
  }
}

let kernelProc = null;
// 内核操作串行队列（#6）：watchdog/config-update/backup/uninstall 多入口并发时，
// 旧版会双 spawn（互相覆盖句柄、抢 8420 端口）。所有启停排一条队，先到先做。
// #46：spawn 失败标志——node 缺失/被改错路径时 'error' 事件异步触发，
// waitHealthy 见到它就提前终止，不再傻等满 60s 超时
let kernelSpawnError = null;
let kernelQueue = Promise.resolve();
function enqueueKernel(fn) {
  const run = kernelQueue.then(fn, fn);
  kernelQueue = run.catch(() => {});
  return run;
}

// 维护窗（#15）：备份停核打包、卸载删库、配置更新期间，看护不得把内核重新拉起
// （热删写库 / 备份打到半 occupied 的库上）
let kernelMaintenance = 0;
export function beginKernelMaintenance() { kernelMaintenance++; }
export function endKernelMaintenance() { kernelMaintenance--; }
export function kernelInMaintenance() { return kernelMaintenance > 0; }

export function kernelRunning() {
  return !!(kernelProc && !kernelProc.killed && kernelProc.exitCode === null);
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
    if (kernelSpawnError) return false; // #46：spawn 已失败，没必须再等
    const h = await health();
    if (h.ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// 启动内核：若 8420 已有健康 Gateway（外部手动启动的）则直接复用。
// 串行队列（#6）：所有调用方排一条队，杜绝并发双 spawn
export function startKernel() {
  return enqueueKernel(_startKernel);
}

async function _startKernel() {
  // 自己已经拉着一个活内核：健康探测瞬时抖动也不能再 spawn——
  // 双实例抢 8420，且后 spawn 的失败退出会把前一个的句柄误置空
  // （现场症状：内核活着却 kernelManaged=false、导入导出被拒、停不掉）
  if (kernelRunning()) return { started: false, reused: true, healthy: true };
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

  kernelSpawnError = null; // #46：每次 spawn 前清失败标志
  let child;
  try {
    child = spawn(nodeExe(), ["--import", "tsx", "src\\gateway\\server.ts"], {
      cwd: kernelDir(),
      env,
      stdio: ["ignore", out, err],
      windowsHide: true,
    });
  } catch (e) {
    // 同步抛出的失败（EFTYPE/EPERM：路径存在但不是可执行文件）：旧版直接
    // 把异常甩给调用方；这里统一收敛成 { started:false }——两类失败（同步抛/异步
    // error 事件）都数秒内失败，绝不挂 60s
    kernelSpawnError = String(e.message || e);
    console.error("[kernel] spawn threw:", kernelSpawnError);
    return { started: false, reused: false, healthy: false, error: kernelSpawnError };
  }
  kernelProc = child;
  // #16：spawn 只把 fd dup 给子进程，父进程侧必须立刻关——
  // 旧版从不 closeSync，每次起内核漏一个 fd，长期运行 EMFILE 拖垮 web
  try { closeSync(out); } catch { /* err 与 out 同 fd，重复关抛 EBADF，忽略 */ }
  // spawn 失败（node.exe 被删/路径错）会异步 emit 'error'——不监听会 throw 崩掉整个 web
  child.on("error", (e) => { console.error("[kernel] spawn error:", String(e.message || e)); kernelSpawnError = String(e.message || e); if (kernelProc === child) kernelProc = null; });
  // exit 仅对当前句柄置空：旧版无条件 null，前一个子进程退出会把在跑内核的句柄也抹掉
  child.on("exit", () => { if (kernelProc === child) kernelProc = null; });

  const ok = await waitHealthy();
  // 超时但进程还活着（半死不活）：杀掉并置空，避免下次 startKernel 重复 spawn 导致进程堆积
  if (!ok && kernelProc === child && child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
    if (kernelProc === child) kernelProc = null;
  }
  // #46：spawn 失败了就不能报 started:true（旧版误导调用方"启动成功"，UI 假绿）
  if (kernelSpawnError) return { started: false, reused: false, healthy: false, error: kernelSpawnError };
  return { started: true, reused: false, healthy: ok, pid: kernelProc?.pid };
}

// 停止内核：与 startKernel 共用串行队列，调用方 await 拿结果
export function stopKernel() {
  return enqueueKernel(_stopKernel);
}

function _stopKernel() {
  if (kernelRunning()) {
    const p = kernelProc;
    try { p.kill("SIGTERM"); } catch { /* 已退出则忽略 */ }
    kernelProc = null; // 先摘句柄；exit 事件里比对 child，不会误伤后来的句柄
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
