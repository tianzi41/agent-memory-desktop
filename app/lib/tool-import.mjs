// tool-import.mjs — 从各 Agent 的本地 JSONL 会话导入记忆
//
// 注册表模式：受支持的客户端集中在 HARNESSES 一条列表里（单一事实来源）。
// 加新客户端只需往数组里加一条记录——server 路由、session_key 前缀、前端分组
// 全部由它驱动，不存在"改了扫描忘了改 UI"这类静默漏改。
//
// 每个 root 都优先尊重工具自身的搬迁变量（deja-vu 同款思路）：用户把目录迁走后
// 不会静默漏扫，而是能用环境变量指到新位置。根目录不存在时报 error；
// 目录存在但一个项目都没扫到时报 warning——"没有数据"和"没找到"必须区分。
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { sanitizeContent } from "./md-parser.mjs";

const HOME = os.homedir();
const envOr = (name, fallback) => (process.env[name] || "").trim() || fallback;

// 收集会话时跳过的子目录：子代理内部流水与工具回填，不是用户与主助手的对话
const SKIP_DIRS = new Set(["subagents", "tool-results", "compression-v2"]);

/**
 * 单一事实来源：每个受支持的客户端一条记录。
 * @prop name      标识（进 API 响应，前端按它分组的 key）
 * @prop label     UI 显示名
 * @prop root      会话根目录（函数形式，求值时才读环境变量——便于测试与热更新）
 * @prop keyPrefix 该项目导入后的 session_key 前缀（总长控制在 60 字符内）
 */
export const HARNESSES = [
  {
    name: "workbuddy",
    label: "WorkBuddy",
    root: () => envOr("WORKBUDDY_HOME", path.join(HOME, ".workbuddy", "projects")),
    keyPrefix: "import-wb-",
  },
  {
    name: "qwen",
    label: "Qwen Workspace",
    root: () => envOr("QWENWORK_HOME", path.join(HOME, ".qwenworkcn", "projects")),
    keyPrefix: "import-qw-",
  },
  {
    // CLAUDE_CONFIG_DIR 指向配置目录（默认 ~/.claude），会话在它下面的 projects/
    name: "claude",
    label: "Claude Code",
    root: () => path.join(envOr("CLAUDE_CONFIG_DIR", path.join(HOME, ".claude")), "projects"),
    keyPrefix: "import-cc-",
  },
];

// 并发上限：项目级并行扫，但不开到几百个同时读——兼顾速度与文件句柄
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// 递归收集目录下所有 .jsonl（跳过 SKIP_DIRS）
async function collectJsonl(dir) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out;
}

// 块数组 → 文本：只收白名单类型的块。
// thinking（思考过程）/ tool_use（工具调用）/ tool_result（工具回填）一律丢弃——
// 它们是过程噪音，进了记忆只会稀释上下文
function blocksToText(arr, types) {
  if (!Array.isArray(arr)) return "";
  return arr
    .filter((c) => c && typeof c.text === "string" && types.includes(c.type))
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// 本地命令元消息：/model 切换、命令回显、local-command-caveat——客户端写给自己的，不是用户意图。
// 实测 Claude Code 一个项目 142 轮里有 30 轮是这类噪音（21%），不过滤会稀释记忆
const META_PREFIX = /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)\b/;
const META_WHOLE = /^\s*(\[Request interrupted by user\]|API Error|Caveat: The messages below)/;

// 剥离客户端注入的上下文块（<system-reminder>…</system-reminder>：工作区快照、连接器状态、
// 当前时间等）。它们是环境信息不是用户当轮说的话；剥完只剩空壳的消息一并丢弃
function stripInjected(text) {
  return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "").trim();
}

// 从 JSONL 一行中提取「角色 + 文本」，无法识别返回 null。三种已知格式：
//   WorkBuddy:  {type:"message", role, content:[{type:"input_text"|"output_text", text}]}
//   Qwen:       {type:"user"|"assistant", message:{content:[{type:"text"|"thinking"|"tool_use"}]}}
//   Claude Code:{type:"user"|"assistant", message:{content}}——user 的 content 常是裸字符串，
//               assistant 才是块数组（Codex / Gemini CLI 等同族格式同理）
function extractTurn(o) {
  let role = null, text = "";
  if (o.type === "message" && (o.role === "user" || o.role === "assistant")) {
    role = o.role;
    text = blocksToText(o.content, ["input_text", "output_text", "text"]);
  } else if (o.type === "user" || o.type === "assistant") {
    role = o.type;
    const c = o.message && o.message.content;
    // 裸字符串直接是用户输入（Claude Code 的 user 消息）；数组则只取 text 块
    text = typeof c === "string" ? c.trim() : blocksToText(c, ["text"]);
  }
  if (!role) return null;
  text = stripInjected(text);
  if (!text || META_PREFIX.test(text) || META_WHOLE.test(text)) return null;
  return { role, text };
}

// 把一个 JSONL 文件解析成「顺序块」数组 [{role, text, ts}]
async function parseJsonlBlocks(file) {
  const blocks = [];
  let text;
  try { text = await readFile(file, "utf8"); } catch { return blocks; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // 子代理（sidechain）内部流水不进主对话——与跳过 subagents/ 目录同一用意
    if (o.isSidechain === true) continue;
    const t = extractTurn(o);
    if (!t) continue;
    let ts = null;
    if (typeof o.timestamp === "number") ts = o.timestamp;
    else if (typeof o.timestamp === "string") { const n = Date.parse(o.timestamp); if (!isNaN(n)) ts = n; }
    blocks.push({ role: t.role, text: t.text, ts });
  }
  return blocks;
}

// 把顺序块组装成 user/assistant 轮次 feed：
// 遇到 user 块，取下一个紧邻的 assistant 块配对（与 md-parser 同逻辑）
function blocksToFeed(blocks) {
  const feed = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].role !== "user") continue;
    const next = blocks[i + 1];
    const userText = sanitizeContent(blocks[i].text.slice(0, 8000));
    const asstText = next && next.role === "assistant"
      ? sanitizeContent(next.text.slice(0, 12000))
      : "（本轮无助手回复）";
    if (!userText) continue;
    feed.push({ user: userText || "（本轮无用户消息）", assistant: asstText });
  }
  return feed;
}

// 对外：解析单个 JSONL 文件为 feed（供导入管道复用）
export async function parseJsonlFile(file) {
  return blocksToFeed(await parseJsonlBlocks(file));
}

// 统计一个项目的元数据：会话数（jsonl 文件数）、消息数、时间跨度、总字节数
async function describeProject(projectName, files, sourceType, keyPrefix) {
  // 文件级并行读：一个项目通常几个到几十个文件，并行能明显缩短墙钟时间
  const parts = await Promise.all(files.map(async (f) => {
    let size = 0, blocks = [];
    try { size = (await stat(f)).size; } catch {}
    try { blocks = await parseJsonlBlocks(f); } catch {}
    return { size, blocks };
  }));
  let totalSize = 0, msgCount = 0, minTs = Infinity, maxTs = -Infinity;
  for (const { size, blocks } of parts) {
    totalSize += size;
    for (const b of blocks) {
      msgCount++;
      if (b.ts) { minTs = Math.min(minTs, b.ts); maxTs = Math.max(maxTs, b.ts); }
    }
  }
  return {
    source: sourceType,
    project: projectName,
    files,
    fileCount: files.length,
    msgCount,
    sizeKB: Math.round(totalSize / 1024),
    startTime: isFinite(minTs) ? new Date(minTs).toISOString() : null,
    endTime: isFinite(maxTs) ? new Date(maxTs).toISOString() : null,
    sessionKey: makeSessionKey(keyPrefix, projectName),
  };
}

// session_key 命名：<前缀><项目名>，总长控制在 60 字符内。两类歧义都必须兜住：
// ① 超长名截断——WorkBuddy 的 "...-Default-Workspace-2026-08-18-15-38-25" 一族
//    只差尾巴的时间戳，截断后实测 120 个项目共用一个 key；
// ② sanitize 把非 ASCII 统一替换成 "_"——"我的项目/测试项目/临时项目" 全部塌缩成
//    同一个 import-qw-____，比 ① 更隐蔽（名字很短，永远走不到截断分支）。
// 因此只要 sanitize 改动过名字（或超长被截断）就补一段完整名的短哈希；
// 纯 ASCII 且未改动的名字 key 保持不变（已导入标记不失效）。
function makeSessionKey(keyPrefix, projectName) {
  const maxBase = 60 - keyPrefix.length;
  const spaced = projectName.replace(/\s+/g, "-");
  const safe = spaced.replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha1").update(projectName).digest("hex").slice(0, 6);
  if (safe === spaced && safe.length <= maxBase) return keyPrefix + safe;
  if (safe.length <= maxBase) return keyPrefix + safe + "-" + hash;
  return keyPrefix + safe.slice(0, maxBase - 7) + "-" + hash;
}

/**
 * 扫描全部已注册客户端——前端与导入管道的唯一入口。
 * 每个来源返回 {source, label, root, error|warning, projects, total}：
 *   error   根目录不存在（工具没装 / 被卸载）
 *   warning 目录在但没扫到任何项目（工具改版迁走了目录？用环境变量指一下）
 * 两者都算"明确告知"，不让调用方把"没找到"误读成"没有数据"。
 */
export async function scanAllHarnesses() {
  return Promise.all(HARNESSES.map(async (h) => {
    const root = h.root();
    try {
      const r = await scanSource(root, h.name, h.keyPrefix);
      return { source: h.name, label: h.label, root, ...r };
    } catch (e) {
      return { source: h.name, label: h.label, root, error: "扫描异常：" + String(e.message || e), projects: [], total: 0 };
    }
  }));
}

async function scanSource(root, sourceType, keyPrefix) {
  if (!existsSync(root)) {
    return { source: sourceType, root, error: `目录不存在：${root}`, projects: [], total: 0 };
  }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (e) { return { source: sourceType, root, error: "读取失败：" + e.message, projects: [], total: 0 }; }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const projects = (await mapLimit(dirs, 8, async (name) => {
    const files = await collectJsonl(path.join(root, name));
    if (!files.length) return null;
    return describeProject(name, files, sourceType, keyPrefix);
  })).filter(Boolean);

  projects.sort((a, b) => b.msgCount - a.msgCount); // 大项目在前方便用户决策

  // 目录存在却零项目：更可能是"没找到"而不是"没有"——给 warning 而非静默空列表
  const warning = projects.length === 0
    ? `目录存在但未发现任何会话：${root}（若该工具改版迁走了目录，可用环境变量指定新路径）`
    : null;
  return { source: sourceType, root, projects, total: projects.length, warning };
}
