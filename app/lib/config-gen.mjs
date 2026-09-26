// config-gen.mjs — 向导配置落盘：yaml（模板生成，不解析）+ .env + app.json
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CFG_DIR = path.join(ROOT, "data", "config");

export function configDir() {
  return CFG_DIR;
}

// 默认数据目录：包内 data/memory-tdai
export function defaultDataDir() {
  return (path.join(ROOT, "data", "memory-tdai")).replaceAll("\\", "/");
}

export function generateYaml({ baseUrl, model, dataDir, port = 8420 }) {
  const baseDir = (dataDir || defaultDataDir()).replaceAll("\\", "/");
  // 导入友好默认：每 2 轮触发提炼、空闲 60s 兜底（Phase 0 发现 E 的缓解）
  return `# AgentMemory Desktop 生成的内核配置（首启向导）
deployMode: standalone
stateBackend: "local"

server:
  port: ${port}
  host: "127.0.0.1"

data:
  baseDir: "${baseDir}"

llm:
  baseUrl: "${baseUrl}"
  apiKey: "\${TDAI_LLM_API_KEY}"
  model: "${model}"
  maxTokens: 4096
  timeoutMs: 120000

memory:
  capture:
    enabled: true
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
  pipeline:
    everyNConversations: 2
    enableWarmup: true
    l1IdleTimeoutSeconds: 60
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"
    timeoutMs: 5000
  storeBackend: "sqlite"
  embedding:
    provider: "none"
  bm25:
    enabled: true
    language: "zh"
`;
}

export function saveSetup({ baseUrl, apiKey, model, dataDir, gatewayPort = 8420 }) {
  mkdirSync(CFG_DIR, { recursive: true });

  // 生成随机网关 API Key（v2 数据面用；v1 路由不强制）
  const gatewayApiKey = "amd-" + randomUUID().replaceAll("-", "");

  writeFileSync(path.join(CFG_DIR, "tdai-gateway.local.yaml"), generateYaml({ baseUrl, model, dataDir, port: gatewayPort }), "utf8");
  writeFileSync(path.join(CFG_DIR, ".env"), `TDAI_LLM_API_KEY=${apiKey}\nTDAI_LLM_BASE_URL=${baseUrl}\nTDAI_LLM_MODEL=${model}\nTDAI_GATEWAY_API_KEY=${gatewayApiKey}\n`, "utf8");

  const app = { setupDone: true, baseUrl, apiKey, model, dataDir: dataDir || defaultDataDir(), gatewayPort, gatewayApiKey, createdAt: new Date().toISOString() };
  writeFileSync(path.join(CFG_DIR, "app.json"), JSON.stringify(app, null, 2), "utf8");
  return app;
}

// 增量更新 LLM 三项（Base URL / Key / 模型）——只替换 yaml 的 llm.baseUrl/model 行
// 与 .env 对应行，其余配置（everyNConversations 等手工调优项）原样保留
export function updateLlmConfig({ baseUrl, apiKey, model }) {
  mkdirSync(CFG_DIR, { recursive: true });

  const yamlPath = path.join(CFG_DIR, "tdai-gateway.local.yaml");
  if (existsSync(yamlPath)) {
    let yaml = readFileSync(yamlPath, "utf8");
    // 锚定 llm: 块内（惰性匹配到 llm 段第一个），避免误伤用户后加的 embedding.baseUrl 等
    yaml = yaml.replace(/(llm:[\s\S]*?baseUrl:\s*")[^"]*(")/, `$1${baseUrl}$2`);
    yaml = yaml.replace(/(llm:[\s\S]*?model:\s*")[^"]*(")/, `$1${model}$2`);
    writeFileSync(yamlPath, yaml, "utf8");
  }

  const envPath = path.join(CFG_DIR, ".env");
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const envSet = (k, v) => env.includes(k + "=")
    ? env.replace(new RegExp(k.replace(/[-_]/g, "\\$&") + "=.*"), `${k}=${v}`)
    : (env += `${k}=${v}\n`);
  envSet("TDAI_LLM_API_KEY", apiKey);
  envSet("TDAI_LLM_BASE_URL", baseUrl);
  envSet("TDAI_LLM_MODEL", model);
  writeFileSync(envPath, env, "utf8");

  const appPath = path.join(CFG_DIR, "app.json");
  let app = {};
  try { app = JSON.parse(readFileSync(appPath, "utf8")); } catch { /* 首次无 app.json 走 saveSetup */ }
  app.baseUrl = baseUrl; app.apiKey = apiKey; app.model = model;
  app.updatedAt = new Date().toISOString();
  writeFileSync(appPath, JSON.stringify(app, null, 2), "utf8");
  return app;
}

// 会话标识（session_key）读写：多客户端共用的记忆命名空间；规则文本按它动态生成
export function getSessionKey() {
  try {
    const app = JSON.parse(readFileSync(path.join(CFG_DIR, "app.json"), "utf8"));
    if (app.sessionKey) return app.sessionKey;
  } catch { /* 无 app.json 时给默认值 */ }
  return process.env.USERNAME || "default";
}

export function setSessionKey(key) {
  mkdirSync(CFG_DIR, { recursive: true });
  const appPath = path.join(CFG_DIR, "app.json");
  let app = {};
  try { app = JSON.parse(readFileSync(appPath, "utf8")); } catch { /* 首次创建 */ }
  app.sessionKey = key;
  app.updatedAt = new Date().toISOString();
  writeFileSync(appPath, JSON.stringify(app, null, 2), "utf8");
  return app;
}
