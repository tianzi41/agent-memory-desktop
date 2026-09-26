// tool-import.mjs — 从 WorkBuddy / Qwen Workspace 的本地 JSONL 会话导入记忆
// 仅做「扫描 + 解析为 feed」，实际 capture/等待提炼复用 importer.mjs 的 startToolImport
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { sanitizeContent } from "./md-parser.mjs";

const HOME = os.homedir();
const WB_ROOT = path.join(HOME, ".workbuddy", "projects");
const QW_ROOT = path.join(HOME, ".qwenworkcn", "projects");

// 收集某项目目录下所有 .jsonl 文件（递归；跳过 subagents / tool-results 子目录，
// 那些是子代理/工具临时产物，不是用户与主助手的对话）
function collectJsonl(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "subagents" || e.name === "tool-results" || e.name === "compression-v2") continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

// 从 JSONL 一行中提取「角色 + 文本」，无法识别返回 null
// WorkBuddy: {type:"message", role:"user|assistant", content:[{type:"input_text"|"output_text", text}]}
// Qwen:     {type:"user|assistant", message:{content:[{type:"text"|"thinking"|"tool_use", text?}]}}
function extractTurn(o) {
  let role = null, text = "";
  if (o.type === "message" && (o.role === "user" || o.role === "assistant")) {
    role = o.role;
    const arr = Array.isArray(o.content) ? o.content : [];
    text = arr.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n").trim();
  } else if (o.type === "user" || o.type === "assistant") {
    role = o.type;
    const msg = o.message;
    const arr = (msg && Array.isArray(msg.content)) ? msg.content : [];
    text = arr.filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text).join("\n").trim();
  }
  if (!role || !text) return null;
  return { role, text };
}

// 把一个 JSONL 文件解析成「顺序块」数组 [{role, text, ts}]
function parseJsonlBlocks(file) {
  const blocks = [];
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return blocks; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
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

// 对外：解析单个 JSONL 文件为 feed（供预览/计数复用）
export function parseJsonlFile(file) {
  return blocksToFeed(parseJsonlBlocks(file));
}

// 统计一个项目的元数据：会话数（jsonl 文件数）、消息数、时间跨度、总字节数
function describeProject(projectName, files, sourceType) {
  let totalSize = 0, msgCount = 0, minTs = Infinity, maxTs = -Infinity;
  for (const f of files) {
    try { totalSize += statSync(f).size; } catch {}
    for (const b of parseJsonlBlocks(f)) {
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
    sessionKey: makeToolSessionKey(sourceType, projectName),
  };
}

// session_key 命名：import-wb-<project> / import-qw-<project>，总长度控制在 60 字符内
function makeToolSessionKey(sourceType, projectName) {
  const prefix = sourceType === "workbuddy" ? "import-wb-" : "import-qw-";
  const maxBase = 60 - prefix.length;
  const safe = projectName.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "_");
  return prefix + safe.slice(0, maxBase);
}

// 扫描 WorkBuddy 全部项目
export function scanWorkbuddyProjects() {
  return scanSource(WB_ROOT, "workbuddy");
}

// 扫描 Qwen Workspace 全部项目
export function scanQwenProjects() {
  return scanSource(QW_ROOT, "qwen");
}

function scanSource(root, sourceType) {
  if (!existsSync(root)) return { source: sourceType, root, error: "目录不存在：" + root, projects: [] };
  const projects = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch (e) {
    return { source: sourceType, root, error: "读取失败：" + e.message, projects: [] };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const files = collectJsonl(path.join(root, e.name));
    if (!files.length) continue;
    projects.push(describeProject(e.name, files, sourceType));
  }
  projects.sort((a, b) => b.msgCount - a.msgCount);
  return { source: sourceType, root, projects, total: projects.length };
}
