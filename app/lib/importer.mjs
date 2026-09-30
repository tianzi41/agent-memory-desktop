// importer.mjs — MD 批量导入管道：逐轮喂入 + 等待提炼节奏控制（Phase 0 发现 D/E 缓解）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadAppConfig } from "./kernel.mjs";
import { configDir, writeFileAtomic } from "./config-gen.mjs";
import { parseFile, parseDocChunks, sanitizeContent } from "./md-parser.mjs";
import { parseJsonlFile } from "./tool-import.mjs";

// 已导入文件清单（去重标记）：data/config/imported-files.json，key = 文件绝对路径
const IMPORTED_PATH = path.join(configDir(), "imported-files.json");
export function loadImportedMap() {
  try { return JSON.parse(readFileSync(IMPORTED_PATH, "utf8")); } catch { return {}; }
}
// 清理失效条目：源文件被删/移动后标记还留着会误导"已导入"，扫描时顺手扫掉
export function pruneImportedMap() {
  const map = loadImportedMap();
  let removed = 0;
  for (const k of Object.keys(map)) {
    if (!existsSync(k)) { delete map[k]; removed++; }
  }
  if (removed) saveImportedMap(map);
  return removed;
}
function saveImportedMap(map) {
  // 原子写 + 合并：导入任务持有的是任务开始时的快照，同期 /api/import/scan 的
  // pruneImportedMap 可能已增删条目——整体覆盖会静默丢对方的修改（去重标记失真）。
  // 每次保存前重读磁盘：磁盘上我们不认识的条目保留，本任务的标记优先。
  try {
    const merged = { ...loadImportedMap(), ...map };
    writeFileAtomic(IMPORTED_PATH, JSON.stringify(merged, null, 2));
  } catch { /* 只影响标记，不影响导入 */ }
}

// 导入任务状态（内存态，重启即失——重试清单同时落盘 data/config/import-log.json）
const state = {
  running: false,
  phase: "idle", // idle | importing | waiting_llm | done | aborted
  total: 0, done: 0,
  currentFile: "", currentRound: 0,
  failures: [],
  startedAt: null, finishedAt: null,
  lastError: null,
};

export function importStatus() {
  return { ...state, running: state.running };
}

async function gwHealth() {
  const cfg = loadAppConfig();
  const port = cfg?.gatewayPort || 8420;
  const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
  return r.ok ? r.json() : null;
}

// 单次 capture 请求（30s 超时——内核忙于 L1 提炼时 /capture 会变慢甚至被拒）
async function gwCaptureOnce(sessionKey, user, assistant) {
  const cfg = loadAppConfig();
  const port = cfg?.gatewayPort || 8420;
  const r = await fetch(`http://127.0.0.1:${port}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_key: sessionKey, user_content: user, assistant_content: assistant }),
    signal: AbortSignal.timeout(30000),
  });
  const ok = r.ok;
  const status = r.status;
  // 读走/取消响应体再返回：undici 会持有底层 socket 直到 body 被消费，
  // 长驻导入进程里每轮都漏就是慢泄漏
  await r.body?.cancel().catch(() => {});
  return ok ? true : status;
}

// 带重试的 capture：网络/超时类失败等 20s 重试（最多 4 次）；400 是确定性失败不重试
async function gwCapture(sessionKey, user, assistant) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try { res = await gwCaptureOnce(sessionKey, user, assistant); } catch { res = false; }
    if (res === true) return true;
    if (res === 400) return false;
    // 最后一次失败不再干等 20s——调用方紧接着就要记失败，白等纯浪费
    if (attempt < 4) await sleep(20000);
  }
  return false;
}

// 等待内核消化完刚喂的一轮：轮询 /health 的 pipelineWorker.tasksCompleted 增量
// （L1 提炼任务完成即计数，无论成功失败；上限 200s > 内核 180s 硬编码超时）
async function waitPipelineSettled(baseCompleted, maxMs = 200_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(3000);
    if (!state.running) return false; // 被中止：立刻退，不再干等满 200s
    const h = await gwHealth().catch(() => null);
    const done = h?.services?.pipelineWorker?.tasksCompleted;
    if (typeof done === "number" && done > baseCompleted) return true;
  }
  return false;
}

// 失败清单封顶 500 条，防止 LLM 持续失败时内存无限增长
function pushFailure(f) {
  if (state.failures.length < 500) state.failures.push(f);
}

// 导出内部辅助函数，供 tool-import 流水线复用（同一套 capture/等待/去重/状态机）
export { gwHealth, gwCapture, waitPipelineSettled, pushFailure, state, saveImportedMap };

// 会话标识生成：聊天记录按文件名、文档加 import-doc- 前缀（预览与实导共用同一份逻辑，保证所见即所得）
function makeSessionKey(file, isChat) {
  const base = file.split(/[\\/]/).pop().replace(/\.md$/i, "");
  return (isChat ? "import-" : "import-doc-") + base.slice(0, isChat ? 60 : 56);
}

// 解析文件为 feed（[{user, assistant}]）——预览与实导共用
function buildFeed(file, text) {
  const isChat = /^### (用户|助手) ·/m.test(text);
  let sessionKey, feed;
  if (isChat) {
    const rounds = parseFile(file, text);
    sessionKey = makeSessionKey(file, true);
    feed = rounds.map((r) => ({
      user: sanitizeContent(r.user) || "（本轮无用户消息）",
      assistant: sanitizeContent(r.assistant) || "（本轮无助手回复）",
    }));
  } else {
    const doc = parseDocChunks(file, text);
    sessionKey = makeSessionKey(file, false);
    feed = doc.chunks.map((c) => ({
      user: sanitizeContent(`请记住以下文档内容（文档《${doc.title}》/ 章节《${c.heading}）：\n\n${c.content}`),
      assistant: "（文档内容已录入，等待记忆提炼）",
    }));
  }
  return { isChat, sessionKey, feed };
}

// 导入前预览：纯解析不落库。返回前 maxFiles 个文件的实际将发送内容（脱敏/切块后），
// 让用户在开跑（可能几小时）前确认 sessionKey、格式、脱敏效果是否符合预期
export function previewImport(files, maxFiles = 3, maxRounds = 2) {
  const out = [];
  for (const file of files.slice(0, maxFiles)) {
    let text = "";
    try { text = readFileSync(file, "utf8"); }
    catch (e) { out.push({ file, error: "读取失败: " + e.message }); continue; }
    let parsed;
    try { parsed = buildFeed(file, text); }
    catch (e) { out.push({ file, error: "解析失败: " + e.message }); continue; }
    const { isChat, sessionKey, feed } = parsed;
    const redactHits = (JSON.stringify(feed).match(/\*\*\*REDACTED\*\*\*/g) || []).length;
    out.push({
      file,
      mode: isChat ? "chat" : "doc",
      sessionKey,
      total: feed.length,
      redactHits,
      sample: feed.slice(0, maxRounds).map((r) => ({
        user: r.user.slice(0, 400),
        assistant: r.assistant.slice(0, 400),
        userTruncated: r.user.length > 400,
        assistantTruncated: r.assistant.length > 400,
      })),
    });
  }
  return { files: out, totalFiles: files.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 主入口：导入一批文件（文件路径数组）
export async function startImport(files) {
  if (state.running) return { ok: false, error: "已有导入任务在跑" };
  Object.assign(state, {
    running: true, phase: "importing", total: files.length, done: 0,
    currentFile: "", currentRound: 0, failures: [],
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  });

  (async () => {
    const importedMap = loadImportedMap();
    try {
      for (const file of files) {
        if (!state.running) break; // 被中止
        state.currentFile = file;

        // 读文件 → 按格式分流：### 用户· = 聊天记录；否则按普通文档切块
        let text = "";
        try { text = readFileSync(file, "utf8"); }
        catch (e) { pushFailure({ file, round: 0, error: "读取失败: " + e.message }); state.done++; continue; }

        let isChat = false, sessionKey = "", total = 0, feed = []; // feed: [{user, assistant}]
        try {
          const parsed = buildFeed(file, text);
          isChat = parsed.isChat; sessionKey = parsed.sessionKey; feed = parsed.feed; total = feed.length;
        } catch (e) {
          pushFailure({ file, round: 0, error: "解析失败: " + e.message });
          state.done++;
          continue;
        }

        // 0 轮/0 块：格式不识别或空文件——不标已导入，记失败供排查
        if (total === 0) {
          pushFailure({ file, round: 0, error: "解析出 0 轮/0 块（空文件或格式不识别，未入库）" });
          state.done++;
          continue;
        }

        for (let i = 0; i < feed.length; i++) {
          if (!state.running) break;
          state.currentRound = i + 1;
          const base = (await gwHealth().catch(() => null))?.services?.pipelineWorker?.tasksCompleted ?? 0;
          const capOk = await gwCapture(sessionKey, feed[i].user, feed[i].assistant).catch(() => false);
          if (!capOk) {
            pushFailure({ file, round: i + 1, error: "capture 请求失败" });
            continue; // 不计 done，失败批可重试
          }
          // 等这轮提炼完（含失败落 cursor 的情形）再喂下一轮，避免 LLM 排队堆积
          state.phase = "waiting_llm";
          const settled = await waitPipelineSettled(base);
          state.phase = "importing";
          if (state.running && !settled) pushFailure({ file, round: i + 1, error: "提炼等待超时(200s)，该轮 L1 可能丢失" });
        }
        // 文件级完成标记（去重用）：只有完整跑完（未被中止）才落标记，
        // 半途文件下次扫描时按"未导入"重新全量导入，避免只导了一半却显示已导入
        if (state.running) {
          importedMap[file] = {
            mode: isChat ? "chat" : "doc",
            rounds: total, importedAt: new Date().toISOString(),
            failCount: state.failures.filter(f => f.file === file).length,
          };
          saveImportedMap(importedMap);
        }
        state.done++;
      }
      state.phase = state.running ? "done" : "aborted";
    } catch (e) {
      state.phase = "aborted";
      state.lastError = String(e.message || e);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return { ok: true };
}

// 从 WorkBuddy / Qwen 导入：projects = [{source, project, files, sessionKey}]
// 每个项目 = 一个 session_key，项目下所有 jsonl 合并成一个 feed 逐轮喂入
export async function startToolImport(projects) {
  if (state.running) return { ok: false, error: "已有导入任务在跑" };
  if (!Array.isArray(projects) || !projects.length) return { ok: false, error: "未选择项目" };
  Object.assign(state, {
    running: true, phase: "importing", total: projects.length, done: 0,
    currentFile: "", currentRound: 0, failures: [],
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  });

  (async () => {
    const importedMap = loadImportedMap();
    try {
      for (const proj of projects) {
        if (!state.running) break;
        state.currentFile = `[${proj.source}] ${proj.project}`;
        const sessionKey = proj.sessionKey;

        // 合并项目下所有 jsonl 为一个 feed
        const feed = [];
        let parseFail = 0;
        for (const f of proj.files) {
          try { feed.push(...(await parseJsonlFile(f))); }
          catch { parseFail++; }
        }
        const total = feed.length;
        if (total === 0) {
          pushFailure({ file: state.currentFile, round: 0, error: `解析出 0 轮（${parseFail} 个文件解析失败），未入库` });
          state.done++;
          continue;
        }

        for (let i = 0; i < feed.length; i++) {
          if (!state.running) break;
          state.currentRound = i + 1;
          const base = (await gwHealth().catch(() => null))?.services?.pipelineWorker?.tasksCompleted ?? 0;
          const capOk = await gwCapture(sessionKey, feed[i].user, feed[i].assistant).catch(() => false);
          if (!capOk) {
            pushFailure({ file: state.currentFile, round: i + 1, error: "capture 请求失败" });
            continue;
          }
          state.phase = "waiting_llm";
          const settled = await waitPipelineSettled(base);
          state.phase = "importing";
          if (state.running && !settled) pushFailure({ file: state.currentFile, round: i + 1, error: "提炼等待超时(200s)，该轮 L1 可能丢失" });
        }
        // 项目级去重标记：key 用 sessionKey（全局唯一），记录来源/项目/轮数
        if (state.running) {
          importedMap[sessionKey] = {
            mode: "tool",
            source: proj.source,
            project: proj.project,
            rounds: total,
            importedAt: new Date().toISOString(),
            failCount: state.failures.filter(f => f.file === state.currentFile).length,
          };
          saveImportedMap(importedMap);
        }
        state.done++;
      }
      state.phase = state.running ? "done" : "aborted";
    } catch (e) {
      state.phase = "aborted";
      state.lastError = String(e.message || e);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return { ok: true };
}

export function abortImport() {
  if (state.running) { state.running = false; return true; }
  return false;
}
