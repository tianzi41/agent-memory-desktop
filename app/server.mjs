// server.mjs — AgentMemory Desktop Web 服务（Node 原生 http，零 npm 依赖）
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { health, startKernel, stopKernel, loadAppConfig, kernelRunning } from "./lib/kernel.mjs";
import { saveSetup, defaultDataDir, updateLlmConfig, getSessionKey, setSessionKey } from "./lib/config-gen.mjs";
import { detectClients, injectClients, traeConfigText } from "./lib/inject.mjs";
import { scanDir } from "./lib/md-parser.mjs";
import { startImport, startToolImport, importStatus, abortImport, loadImportedMap, pruneImportedMap, previewImport } from "./lib/importer.mjs";
import { scanAllHarnesses } from "./lib/tool-import.mjs";
import { autostartStatus, setAutostart, repairAutostartPath } from "./lib/autostart.mjs";
import { exportBackup, importBackup } from "./lib/backup.mjs";
import { uninstallPlan, runUninstall } from "./lib/uninstall.mjs";
import { startHttpBridge, stopHttpBridge, httpBridgeRunning } from "./lib/http-bridge.mjs";
import { updateDaily, getDaily } from "./lib/daily-stats.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "static");
const BACKUP_ROOT = path.resolve(import.meta.dirname, "..", "backup");
const PORT = 8430;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Buffer 收集 + 一次性 concat 解码：不能 `data += c` 逐块转字符串——
    // 多字节中文字符跨 TCP 段边界会被截断成 U+FFFD，且 JSON.parse 照样成功（静默数据损坏）
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > 5 * 1024 * 1024) { settled = true; reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

// 网关 v1 转发（capture/search 用）
async function gatewayPost(pathname, payload, timeoutMs = 30000) {
  const cfg = loadAppConfig();
  const port = cfg?.gatewayPort || 8420;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } finally { clearTimeout(t); }
}

// 网关 v2/v3 数据面转发（记忆管理用；v3 需严格隔离头）
async function gatewayData(pathname, payload, v3 = false) {
  const cfg = loadAppConfig();
  const port = cfg?.gatewayPort || 8420;
  const key = cfg?.gatewayApiKey;
  if (!key) return { ok: false, status: 401, body: { error: "缺少 gatewayApiKey（重新运行首启向导）" } };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "x-tdai-service-id": "default" };
  if (v3) Object.assign(headers, { "x-tdai-team-id": "default", "x-tdai-agent-id": "default", "x-tdai-user-id": "default" });
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST", headers, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(30000),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, status: 502, body: { error: String(e.message || e) } };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // ---- 安全：拒绝跨站调用 ----
    // 浏览器发往 127.0.0.1 的请求必带 Origin 头；本地 curl/脚本无 Origin（可信）放行。
    // 没有这道关，任意网页的 JS 都能 fetch 打我们的 API（CSRF：改配置、写 mcp.json、停服务）
    if (url.pathname.startsWith("/api/")) {
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:8430)?$/.test(origin)) {
        json(res, 403, { ok: false, error: "forbidden origin（仅接受本机页面发起的请求）" });
        return;
      }
    }

    // ---- 备份 zip 下载（须在静态文件分支前：/backup/ 不是 /api/ 前缀）----
    if (url.pathname.startsWith("/backup/") && req.method === "GET") {
      const name = path.basename(decodeURIComponent(url.pathname.slice("/backup/".length)));
      if (!name.endsWith(".zip")) { res.writeHead(403); res.end("only .zip"); return; }
      const f = path.join(BACKUP_ROOT, name);
      if (!f.startsWith(BACKUP_ROOT) || !existsSync(f)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": statSync(f).size,
      });
      res.end(readFileSync(f));
      return;
    }

    // ---- 静态文件 ----
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      let file = url.pathname === "/" ? "/index.html" : url.pathname;
      file = path.normalize(path.join(STATIC_DIR, file));
      if (!file.startsWith(STATIC_DIR) || !existsSync(file)) { res.writeHead(404); res.end("unknown api"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }

    // ---- API ----
    if (url.pathname === "/api/status" && req.method === "GET") {
      const cfg = loadAppConfig();
      const h = await health(3000);
      json(res, 200, {
        setupDone: !!cfg,
        model: cfg?.model, baseUrl: cfg?.baseUrl,
        apiKeyMasked: cfg?.apiKey ? cfg.apiKey.slice(0, 6) + "..." : null,
        apiKey: cfg?.apiKey || null, // 仅本机 127.0.0.1 监听，修改配置表单预填用
        dataDir: cfg?.dataDir || defaultDataDir(),
        gateway: { healthy: h.ok, detail: h.body?.services ? { pipeline: h.body.services.pipelineWorker } : h.error },
        httpBridge: { running: httpBridgeRunning(), url: "http://127.0.0.1:8410/mcp" },
        gatewayPort: cfg?.gatewayPort || 8420,
        kernelManaged: kernelRunning(),
      });
      return;
    }

    if (url.pathname === "/api/clients" && req.method === "GET") {
      json(res, 200, detectClients());
      return;
    }

    if (url.pathname === "/api/trae-config" && req.method === "GET") {
      const cfg = loadAppConfig();
      json(res, 200, { text: traeConfigText(cfg?.gatewayPort || 8420) });
      return;
    }

    // 会话标识（session_key）：多客户端共用的记忆命名空间
    if (url.pathname === "/api/session-key" && req.method === "GET") {
      json(res, 200, { key: getSessionKey() });
      return;
    }
    if (url.pathname === "/api/session-key" && req.method === "POST") {
      const { key } = await readBody(req);
      const k = String(key || "").trim();
      if (!k || k.length > 40) { json(res, 400, { ok: false, error: "标识不能为空，且不超过 40 个字符" }); return; }
      setSessionKey(k);
      json(res, 200, { ok: true, key: k });
      return;
    }

    if (url.pathname === "/api/test-model" && req.method === "POST") {
      const { baseUrl, apiKey, model } = await readBody(req);
      if (!baseUrl || !apiKey || !model) { json(res, 400, { ok: false, error: "缺参数" }); return; }
      const t0 = Date.now();
      try {
        const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
          signal: AbortSignal.timeout(30000),
        });
        const body = await r.json().catch(() => null);
        const ms = Date.now() - t0;
        if (r.ok && body?.choices) json(res, 200, { ok: true, ms, reply: body.choices[0]?.message?.content || "" });
        else json(res, 200, { ok: false, ms, error: body?.error?.message || `HTTP ${r.status}` });
      } catch (e) {
        json(res, 200, { ok: false, ms: Date.now() - t0, error: String(e.message || e) });
      }
      return;
    }

    if (url.pathname === "/api/setup" && req.method === "POST") {
      const { baseUrl, apiKey, model, dataDir } = await readBody(req);
      if (!baseUrl || !apiKey || !model) { json(res, 400, { ok: false, error: "缺参数" }); return; }
      const app = saveSetup({ baseUrl, apiKey, model, dataDir });
      const k = await startKernel();
      json(res, 200, { ok: true, kernel: k });
      return;
    }

    // 修改 LLM 配置（Base URL / Key / 模型）——增量更新，保留其他手工调优项；保存后重启内核生效
    if (url.pathname === "/api/config/update" && req.method === "POST") {
      const { baseUrl, apiKey, model } = await readBody(req);
      if (!baseUrl || !apiKey || !model) { json(res, 400, { ok: false, error: "缺参数" }); return; }
      updateLlmConfig({ baseUrl, apiKey, model });
      stopKernel();
      await sleep(2000);
      const k = await startKernel();
      json(res, 200, { ok: true, kernel: k });
      return;
    }

    if (url.pathname === "/api/inject" && req.method === "POST") {
      const { clients } = await readBody(req);
      const cfg = loadAppConfig();
      const results = injectClients(clients || [], cfg?.gatewayPort || 8420);
      json(res, 200, { ok: true, results });
      return;
    }

    if (url.pathname === "/api/kernel/start" && req.method === "POST") {
      kernelStoppedByUser = false; // 用户显式启动：看护恢复管辖权
      kernelHealthMiss = 0;
      const k = await startKernel();
      json(res, 200, k);
      return;
    }

    if (url.pathname === "/api/kernel/stop" && req.method === "POST") {
      kernelStoppedByUser = true; // 手动停止：看护不插手，直到用户点启动
      kernelHealthMiss = 0;
      json(res, 200, { stopped: stopKernel() });
      return;
    }

    // 开机自启 + watchdog（UI 按钮开关）
    if (url.pathname === "/api/autostart" && req.method === "GET") {
      json(res, 200, autostartStatus());
      return;
    }
    if (url.pathname === "/api/autostart" && req.method === "POST") {
      const { enable } = await readBody(req);
      if (typeof enable !== "boolean") { json(res, 400, { ok: false, error: "缺 enable" }); return; }
      json(res, 200, setAutostart(enable));
      return;
    }

    // 验证辅助：capture + search（向导完成后自测闭环用）
    if (url.pathname === "/api/kernel/capture" && req.method === "POST") {
      const { sessionKey, userContent, assistantContent } = await readBody(req);
      if (!sessionKey || !userContent) { json(res, 400, { ok: false, error: "缺参数" }); return; }
      const r = await gatewayPost("/capture", { session_key: sessionKey, user_content: userContent, assistant_content: assistantContent || "" });
      json(res, r.ok ? 200 : 502, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/kernel/search" && req.method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) { json(res, 400, { ok: false, error: "缺 q" }); return; }
      const r = await gatewayPost("/search/memories", { query: q, limit: 5 });
      json(res, r.ok ? 200 : 502, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/import/preview" && req.method === "POST") {
      const { files } = await readBody(req);
      if (!Array.isArray(files) || !files.length) { json(res, 400, { ok: false, error: "缺 files 数组" }); return; }
      json(res, 200, { ok: true, ...previewImport(files) });
      return;
    }

    // ---- M2：MD 批量导入 ----
    if (url.pathname === "/api/import/scan" && req.method === "POST") {
      const { dir } = await readBody(req);
      if (!dir) { json(res, 400, { ok: false, error: "缺 dir" }); return; }
      pruneImportedMap(); // 顺手清理源文件已失效的去重标记
      const result = scanDir(dir);
      // 合并已导入标志（去重）：imported=已导入过；changed=轮次数与上次不同（文件被更新过）
      if (result.sessions) {
        const imported = loadImportedMap();
        for (const s of result.sessions) {
          const rec = imported[s.file];
          s.imported = !!rec;
          s.changed = !!rec && rec.rounds !== s.rounds;
        }
      }
      json(res, 200, result);
      return;
    }

    if (url.pathname === "/api/import/start" && req.method === "POST") {
      const { files } = await readBody(req);
      if (!Array.isArray(files) || !files.length) { json(res, 400, { ok: false, error: "缺 files" }); return; }
      json(res, 200, await startImport(files));
      return;
    }

    if (url.pathname === "/api/import/status" && req.method === "GET") {
      json(res, 200, importStatus());
      return;
    }

    if (url.pathname === "/api/import/abort" && req.method === "POST") {
      json(res, 200, { aborted: abortImport() });
      return;
    }

    // ---- 从 WorkBuddy / Qwen Workspace 导入（JSONL 本地会话）----
    if (url.pathname === "/api/tool-import/scan" && req.method === "GET") {
      // 遍历注册表：新增客户端无需改这里（单一事实来源在 tool-import.mjs 的 HARNESSES）
      const sources = await scanAllHarnesses();
      const imported = loadImportedMap();
      for (const s of sources) for (const p of s.projects) p.imported = !!imported[p.sessionKey];
      json(res, 200, { sources });
      return;
    }

    if (url.pathname === "/api/tool-import/start" && req.method === "POST") {
      const { projects } = await readBody(req);
      if (!Array.isArray(projects) || !projects.length) { json(res, 400, { ok: false, error: "未选择项目" }); return; }
      json(res, 200, await startToolImport(projects));
      return;
    }

    // ---- M3：记忆管理（v2/v3 数据面） ----
    // 今日统计：立即采样一次再返回（页面刷新即最新）；无页面时由 20s 轮询持续累加
    if (url.pathname === "/api/daily-stats" && req.method === "GET") {
      json(res, 200, await sampleDailyStats());
      return;
    }

    if (url.pathname === "/api/memories/stats" && req.method === "GET") {
      const [l0, l1, l2] = await Promise.all([
        gatewayData("/v3/conversation/count", {}, true),
        gatewayData("/v3/atomic/count", {}, true),
        gatewayData("/v3/scenario/count", {}, true),
      ]);
      json(res, 200, {
        l0: l0.body?.data?.total ?? null, l1: l1.body?.data?.total ?? null, l2: l2.body?.data?.total ?? null,
        error: [l0, l1, l2].find(r => !r.ok)?.body?.error,
      });
      return;
    }

    if (url.pathname === "/api/memories/l1" && req.method === "GET") {
      const q = url.searchParams.get("q");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 100);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
      const type = url.searchParams.get("type") || undefined;
      const r = q
        ? await gatewayData("/v2/atomic/search", { query: q, limit, type })
        : await gatewayData("/v2/atomic/query", { limit, offset, type });
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/memories/l1/delete" && req.method === "POST") {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length) { json(res, 400, { ok: false, error: "缺 ids" }); return; }
      const r = await gatewayData("/v2/atomic/delete", { ids });
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    // L1 记忆编辑（纠错/更新内容）
    if (url.pathname === "/api/memories/l1/update" && req.method === "POST") {
      const { id, content } = await readBody(req);
      if (!id || !content) { json(res, 400, { ok: false, error: "缺 id 或 content" }); return; }
      const r = await gatewayData("/v2/atomic/update", { id, content });
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/memories/l0" && req.method === "GET") {
      const q = url.searchParams.get("q");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 100);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
      // 有关键词走语义搜索，无关键词浏览原始流水
      const r = q
        ? await gatewayData("/v2/conversation/search", { query: q, limit })
        : await gatewayData("/v2/conversation/query", { limit, offset });
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/memories/l3" && req.method === "GET") {
      const r = await gatewayData("/v2/core/read", {});
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/memories/l2" && req.method === "GET") {
      const r = await gatewayData("/v2/scenario/ls", {});
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/memories/l2/read" && req.method === "GET") {
      const p = url.searchParams.get("path");
      if (!p) { json(res, 400, { ok: false, error: "缺 path" }); return; }
      const r = await gatewayData("/v2/scenario/read", { path: p });
      json(res, r.ok ? 200 : r.status, r.body ?? r);
      return;
    }

    if (url.pathname === "/api/shutdown" && req.method === "POST") {
      json(res, 200, { ok: true });
      stopKernel();
      stopHttpBridge();
      setTimeout(() => process.exit(0), 300).unref();
      return;
    }

    // ---- 备份 / 迁移 ----
    // 导出：停内核 -> tar 打包数据目录 -> 重启内核（可能耗时数十秒，前端展示进度文案）
    if (url.pathname === "/api/backup/export" && req.method === "POST") {
      json(res, 200, await exportBackup());
      return;
    }

    // 恢复：body 为 zip 原始二进制（不走 JSON 解析，限 500MB）
    if (url.pathname === "/api/backup/import" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 500 * 1024 * 1024) { json(res, 400, { ok: false, error: "文件超过 500MB 上限" }); return; }
        chunks.push(c);
      }
      const r = await importBackup(Buffer.concat(chunks));
      json(res, r.ok ? 200 : 400, r);
      return;
    }

    // ---- 卸载 ----
    if (url.pathname === "/api/uninstall/plan" && req.method === "GET") {
      json(res, 200, { ok: true, ...uninstallPlan() });
      return;
    }

    if (url.pathname === "/api/uninstall" && req.method === "POST") {
      kernelStoppedByUser = true; // 卸载途中禁止看护复活内核
      const body = await readBody(req);
      const r = await runUninstall({ removeData: !!body.removeData });
      json(res, 200, r);
      // 卸载完成后自我退出（web 是内核与卸载流程的宿主；响应先返回再退出）
      setTimeout(() => process.exit(0), 500).unref();
      return;
    }

    json(res, 404, { ok: false, error: "unknown api" });
  } catch (e) {
    // 响应已开始写（头已发送）时再 writeHead 会抛 ERR_HTTP_HEADERS_SENT，
    // 那个异常没人接会把整个 web 进程带走（Node 22 未处理拒绝即退出码 1）
    if (!res.headersSent) json(res, 500, { ok: false, error: String(e.message || e) });
    else { try { res.destroy(); } catch { /* 连接已断，无需补救 */ } }
  }
});

// Node 22 下未处理的 Promise rejection 默认终止进程：一个漏 await 的路由出错
// 曾直接杀掉整个 web（内核子进程陪葬、在途导入/备份丢失）。这里兜底记录，保住进程。
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e instanceof Error ? e.stack || e.message : String(e));
});
process.on("uncaughtException", (e) => {
  // 未捕获异常后进程状态不可信：记录后退出，交给 watchdog.ps1 拉活（好过带着坏状态继续跑）
  console.error("[uncaughtException]", e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});

// 今日统计采样：L0 总条数（v3 count）+ 内核 /health 的提炼计数器，交累加器算差量
async function sampleDailyStats() {
  try {
    const [l0r, h] = await Promise.all([
      gatewayData("/v3/conversation/count", {}, true).catch(() => null),
      health(8000).catch(() => null),
    ]);
    const pw = h?.body?.services?.pipelineWorker; // health() 返回 {ok,status,body} 包装，真身在 body
    // 看护计数：采到健康就归零，连续 miss 到阈值交给 watchdogKernel 决断
    if (h?.ok) kernelHealthMiss = 0; else kernelHealthMiss++;
    if (kernelHealthMiss >= 2) await watchdogKernel();
    const l0Total = l0r?.body?.data?.total;
    if (typeof l0Total !== "number" && !pw) return getDaily(); // 内核不在：不采样，返回累计值
    return updateDaily({ l0Total, tasksDone: pw?.tasksCompleted, tasksFailed: pw?.tasksFailed });
  } catch {
    return getDaily();
  }
}

// 内核看护：watchdog.ps1 只保 Web(8430)，内核(8420)死了没人拉——页面会一直显示"未运行"。
// 这里借 20s 统计轮询顺带自愈：连续两次采不到健康就重启。
// 三道闸：(1) 手动点过「停止」则不插手，避免跟用户意图打架；
//         (2) 重启后冷却 2 分钟，防反复失败变成重启风暴；
//         (3) 重启过程中不并发触发，否则会 spawn 出多个内核进程。
let kernelHealthMiss = 0;
let kernelStoppedByUser = false;
let kernelRestarting = false;
let kernelLastRestartAt = 0;

async function watchdogKernel() {
  if (kernelStoppedByUser || kernelRestarting) return;
  if (!loadAppConfig()) return; // 未完成向导：没有配置可拉，startKernel 会抛
  if (Date.now() - kernelLastRestartAt < 120_000) return; // 冷却中
  kernelRestarting = true;
  try {
    console.log("[watchdog] kernel unhealthy (miss=" + kernelHealthMiss + "), restarting...");
    const k = await startKernel();
    kernelLastRestartAt = Date.now();
    kernelHealthMiss = 0;
    console.log("[watchdog] kernel restart " + (k.healthy ? "ok" : "started but unhealthy"));
  } catch (e) {
    kernelLastRestartAt = Date.now();
    console.error("[watchdog] kernel restart failed: " + String(e.message || e));
  } finally {
    kernelRestarting = false;
  }
}


server.listen(PORT, "127.0.0.1", () => {
  console.log(`[AgentMemory Desktop] http://127.0.0.1:${PORT}`);
  // 今日统计轮询（20s）：无页面打开也持续累加；跨天由累加器自动清零
  setInterval(() => { sampleDailyStats().catch(() => {}); }, 20000);
  // app 文件夹被移动后，开机自启 VBS 里的旧路径失效——静默重写（自愈）
  try { repairAutostartPath(); } catch { /* 自愈失败不影响启动 */ }
  // HTTP 桥（豆包等只支持 URL 的客户端用）：随 web 起停
  startHttpBridge().then((r) => console.log(`[AgentMemory Desktop] http-bridge ${r.started ? (r.healthy ? "up" : "starting...") : "reused/failed"}`)).catch(() => {});
  // watchdog/重启场景自愈：已完成配置但内核未运行时自动拉起
  // （内核是本进程的子进程，Web 被杀时内核会一起死，Web 复活后须重建）
  (async () => {
    try {
      if (!loadAppConfig()) return; // 未完成向导不拉
      const h = await health(3000).catch(() => ({ ok: false }));
      if (!h.ok) {
        console.log("[AgentMemory Desktop] kernel down, auto-starting...");
        await startKernel();
        console.log("[AgentMemory Desktop] kernel auto-start done");
      }
    } catch (e) {
      // 自动拉起失败不能变成未处理拒绝把进程带走（watchdog 30s 后会再拉 web）
      console.error("[AgentMemory Desktop] kernel auto-start failed: " + String(e.message || e));
    }
  })();
});
