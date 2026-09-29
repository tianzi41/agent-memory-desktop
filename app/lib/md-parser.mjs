// md-parser.mjs — 解析用户导出的聊天记录 MD（### 用户 · 时间 / ### 助手 · 时间）
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

// 反斜杠清洗（Phase 0 发现 C）：仅 Windows 盘符路径 Q:\xxx -> Q:/xxx
// （记忆规则要求路径统一正斜杠）。孤立反斜杠不动——\n、\d+、\frac、正则等
// 代码样本全靠它，全局转换会毁掉技术文档（导入审查教训）。
// 密钥脱敏：常见 token/key 格式保留前 4 后 4，中间打码，防止明文秘钥入库
const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                    // OpenAI/SiliconFlow/Anthropic 风格
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,               // GitHub PAT 家族
  /\bAKIA[0-9A-Z]{16}\b/g,                          // AWS AccessKey
  /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g,             // Slack
  /\b(?:api[_-]?key|apikey|token|secret|passwd|password|pwd)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi, // key=value 模式
];
// 弱特征（长 hex / 长 base64）：单独出现多为 git hash、URL 路径、data URI，
// 只有 60 字符窗口内出现密钥上下文词才打码（避免误伤代码与路径）
const WEAK_PATTERNS = [
  /\b[A-Fa-f0-9]{32,}\b/g,                          // 长 hex（md5/sha/密钥）
  /\b[A-Za-z0-9+\/]{40,}={0,2}\b/g,                 // 长 base64 串
];
const KEY_CONTEXT = /(api[_-]?key|apikey|token|secret|passwd|password|pwd|signature|sig|md5|sha\d*|密钥|秘钥|签名|credential|hash)/i;

function mask(m) {
  return m.length < 12 ? m : m.slice(0, 4) + "***REDACTED***" + m.slice(-4);
}

function redactSecrets(text) {
  for (const re of REDACT_PATTERNS) {
    text = text.replace(re, (m) => mask(m));
  }
  for (const re of WEAK_PATTERNS) {
    text = text.replace(re, (m, offset) => {
      const ctx = text.slice(Math.max(0, offset - 60), offset) + text.slice(offset + m.length, offset + m.length + 60);
      return KEY_CONTEXT.test(ctx) ? mask(m) : m;
    });
  }
  return text;
}

// Windows 盘符路径整体转正斜杠：Q:\a\b\c.py -> Q:/a/b/c.py
// （只认"盘符: 后跟反斜杠段"的完整路径；段内允许空格与中文以兼容中文目录，
//  遇引号/换行/通配符即停，孤立 \d \n \frac 等代码转义不受影响）
function normalizeWinPaths(text) {
  return text.replace(/([A-Za-z]):((?:\\+[^\\"'`|<>*?\r\n]+)+)/g, (m, drive, rest) => drive + ":" + rest.replace(/\\+/g, "/"));
}

export function sanitizeContent(text) {
  return redactSecrets(normalizeWinPaths(text));
}

// 扫描目录：一级子目录下的 *.md（用户导出格式：会话目录/会话文件.md）
export function scanDir(dir) {
  const sessions = [];
  if (!existsSync(dir)) return { error: "目录不存在" };
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { error: "目录读取失败: " + String(e.message || e) }; } // 比如传入的是文件路径（ENOTDIR）
  for (const e of entries) {
    if (!e.isDirectory()) {
      // 根目录下直接的 md 也收
      if (e.name.endsWith(".md")) {
        const f = path.join(dir, e.name);
        sessions.push(describeFile(f));
      }
      continue;
    }
    let sub;
    try { sub = readdirSync(path.join(dir, e.name), { withFileTypes: true }); }
    catch { continue; } // 单个子目录不可读不拖垮整次扫描
    for (const f of sub) {
      if (f.isFile() && f.name.endsWith(".md")) {
        const full = path.join(dir, e.name, f.name);
        sessions.push(describeFile(full));
      }
    }
  }
  sessions.sort((a, b) => a.rounds - b.rounds); // 小文件先导，快速见效果
  return { dir, total: sessions.length, sessions };
}

function describeFile(file) {
  let mode = "doc", count = 0, size = 0;
  try {
    const stat = statSync(file);
    size = stat.size;
    const text = readFileSync(file, "utf8");
    if (/^### (用户|助手) ·/m.test(text)) {
      mode = "chat";
      count = parseFile(file, text, { countOnly: true });
    } else {
      count = parseDocChunks(file, text, { countOnly: true });
    }
  } catch (e) { /* 解析失败的文件 count=0 */ }
  return { file, name: path.basename(file, ".md"), sizeKB: Math.round(size / 1024), rounds: count, mode };
}

// 普通文档模式：按 ## 二级标题切块（无 ## 时整篇一块）；
// 块超 6000 字先按 ### 细切，仍超长硬切 5500 字段。返回 {title, chunks:[{heading, content}]}
export function parseDocChunks(file, text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const title = (lines.find((l) => /^# /.test(l)) || "# " + path.basename(file, ".md"))
    .replace(/^#\s*/, "").trim().slice(0, 100);

  const chunks = [];
  let cur = { heading: "", content: [] };
  const flush = () => {
    const c = cur.content.join("\n").trim();
    if (c) chunks.push({ heading: cur.heading || "开篇", content: c });
    cur = { heading: "", content: [] };
  };
  for (const line of lines) {
    if (/^## /.test(line)) { flush(); cur.heading = line.replace(/^##\s*/, "").trim().slice(0, 100); continue; }
    if (/^# /.test(line)) continue; // 文档大标题只入 title
    cur.content.push(line);
  }
  flush();

  // 超长块按 ### 细切
  const mid = [];
  for (const ch of chunks) {
    if (ch.content.length <= 6000) { mid.push(ch); continue; }
    let sub = { h: "", c: [] };
    for (const line of ch.content.split("\n")) {
      if (/^### /.test(line)) {
        if (sub.c.join("\n").trim()) mid.push({ heading: ch.heading + " / " + sub.h, content: sub.c.join("\n").trim() });
        sub = { h: line.replace(/^###\s*/, "").trim().slice(0, 100), c: [] };
      } else sub.c.push(line);
    }
    if (sub.c.join("\n").trim()) mid.push({ heading: ch.heading + " / " + sub.h, content: sub.c.join("\n").trim() });
  }
  // 无 ### 仍超长：硬切
  const out = [];
  for (const ch of mid) {
    if (ch.content.length <= 6000) { out.push(ch); continue; }
    const parts = Math.ceil(ch.content.length / 5500);
    for (let i = 0; i < parts; i++) {
      out.push({ heading: `${ch.heading}（${i + 1}/${parts}）`, content: ch.content.slice(i * 5500, (i + 1) * 5500) });
    }
  }
  if (opts.countOnly) return out.length; // 细分后再计数，与实际导入块数一致（去重对比用）
  return { title, chunks: out };
}

// 解析单个 MD → rounds: [{user, assistant, ts}]
// 格式（实测自本地聊天记录导出目录）：
//   ### 用户 · 2026-08-11 12:44:08
//   正文（可含 > 调用工具 引用块，剥离）
//   ### 助手 · 2026-08-11 12:44:25
//   正文
export function parseFile(file, text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const rounds = [];
  let cur = null;         // { role, ts, content: [] }
  const blocks = [];      // 顺序块

  for (const line of lines) {
    const m = line.match(/^### (用户|助手) · (.+)$/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { role: m[1] === "用户" ? "user" : "assistant", ts: m[2].trim(), content: [] };
    } else if (cur) {
      // 剥离工具调用元信息引用块
      if (/^> (调用工具|参数：)/.test(line)) continue;
      cur.content.push(line);
    }
  }
  if (cur) blocks.push(cur);

  if (opts.countOnly) {
    // 粗计轮数：用户块出现次数
    return blocks.filter(b => b.role === "user").length;
  }

  // 组装轮次：user 块 + 其后紧邻的 assistant 块
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.role !== "user") continue;
    const next = blocks[i + 1];
    const userText = b.content.join("\n").trim().slice(0, 8000);
    const asstText = next && next.role === "assistant" ? next.content.join("\n").trim().slice(0, 12000) : "";
    if (!userText && !asstText) continue;
    rounds.push({ user: userText, assistant: asstText, ts: b.ts });
  }
  return rounds;
}

export function parseRoundFile(file) {
  return parseFile(file, readFileSync(file, "utf8"));
}
