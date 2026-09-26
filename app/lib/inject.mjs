// inject.mjs — 客户端检测与 MCP 配置注入（写入前一律先备份原件）
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BRIDGE = path.join(ROOT, "bridge", "mcp_agent_memory.py").replaceAll("\\", "/");
const BACKUP_DIR = path.join(ROOT, "backup");

function pythonExe() {
  const bundled = path.join(ROOT, "runtime", "python", "python.exe");
  return existsSync(bundled) ? bundled.replaceAll("\\", "/") : "python";
}

export function mcpEntry(gatewayUrl) {
  return {
    command: pythonExe(),
    args: [BRIDGE],
    env: { TDAI_GATEWAY_URL: gatewayUrl },
  };
}

function backupFile(file) {
  if (!existsSync(file)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const dst = path.join(BACKUP_DIR, `${path.basename(file)}.${ts}.bak`);
  copyFileSync(file, dst);
  return dst;
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// ---- 客户端检测 ----
export function detectClients() {
  const cursorDir = path.join(process.env.USERPROFILE, ".cursor");
  const claudeDir = path.join(process.env.APPDATA, "Claude");
  const workbuddyDir = path.join(process.env.USERPROFILE, ".workbuddy");
  return {
    cursor: {
      name: "Cursor",
      installed: existsSync(cursorDir),
      configFile: path.join(cursorDir, "mcp.json"),
      injectable: true,
    },
    claude: {
      name: "Claude Desktop",
      installed: existsSync(claudeDir),
      configFile: path.join(claudeDir, "claude_desktop_config.json"),
      injectable: true,
    },
    workbuddy: {
      name: "WorkBuddy",
      installed: existsSync(workbuddyDir),
      configFile: path.join(workbuddyDir, "mcp.json"),
      injectable: true,
      note: "写入后需到 连接器管理 → 自定义连接 对 agent-memory 点「信任」才会生效",
    },
    trae: {
      name: "TRAE / TRAE CN",
      installed: true, // 本机已装（当前就在用）
      injectable: false, // 配置在设置中心 UI 管理，无本地文件可写
      note: "在 设置中心 → MCP → 手动添加 粘贴下方 JSON",
    },
  };
}

// ---- 通用注入：合并 mcpServers.agent-memory 到目标 json ----
function injectToConfigFile(configFile, gatewayUrl) {
  const existed = existsSync(configFile);
  const backup = backupFile(configFile);
  const json = readJson(configFile);
  json.mcpServers = json.mcpServers || {};
  json.mcpServers["agent-memory"] = mcpEntry(gatewayUrl);

  const dir = path.dirname(configFile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(json, null, 2), "utf8");
  return { ok: true, file: configFile, existed, backup };
}

export function injectClients(clientIds, gatewayPort = 8420) {
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const clients = detectClients();
  const results = {};
  for (const id of clientIds) {
    const c = clients[id];
    if (!c || !c.injectable) { results[id] = { ok: false, error: "该客户端不支持自动注入" }; continue; }
    try {
      results[id] = injectToConfigFile(c.configFile, gatewayUrl);
    } catch (e) {
      results[id] = { ok: false, error: String(e.message || e) };
    }
  }
  return results;
}

// ---- 反注入：从目标 json 删除 mcpServers.agent-memory（写前备份，其他 server 原样保留）----
function removeFromConfigFile(configFile) {
  if (!existsSync(configFile)) return { ok: true, file: configFile, existed: false, removed: false };
  const backup = backupFile(configFile);
  const json = readJson(configFile);
  const had = !!(json.mcpServers && json.mcpServers["agent-memory"]);
  if (json.mcpServers) delete json.mcpServers["agent-memory"];
  writeFileSync(configFile, JSON.stringify(json, null, 2), "utf8");
  return { ok: true, file: configFile, existed: true, removed: had, backup };
}

// 卸载用：反注入所有已安装客户端
export function removeClients() {
  const clients = detectClients();
  const results = {};
  for (const [id, c] of Object.entries(clients)) {
    if (!c.injectable || !c.installed) continue;
    try { results[id] = removeFromConfigFile(c.configFile); }
    catch (e) { results[id] = { ok: false, error: String(e.message || e) }; }
  }
  return results;
}

// TRAE CN 手动粘贴用 JSON
export function traeConfigText(gatewayPort = 8420) {
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  return JSON.stringify({
    mcpServers: {
      "agent-memory": {
        command: pythonExe(),
        args: [BRIDGE],
        env: { TDAI_GATEWAY_URL: gatewayUrl },
      },
    },
  }, null, 2);
}
