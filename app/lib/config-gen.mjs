// config-gen.mjs — 向导配置落盘：yaml（模板生成，不解析）+ .env + app.json
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CFG_DIR = path.join(ROOT, "data", "config");

export function configDir() {
  return CFG_DIR;
}

// 原子写：同目录先写 .tmp 再 rename——崩溃/断电不会留下截断的 app.json
// （截断的配置会让此后每次 loadAppConfig 都失败，见 kernel.mjs 的容错）
export function writeFileAtomic(p, data) {
  const tmp = p + ".tmp";
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, p);
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

// YAML 双引号串内插值前先拒绝破坏性字符：含 " 或换行的值会破坏 yaml 结构甚至注入键
function assertYamlSafe(v, name) {
  if (/[\r\n"]/.test(String(v))) throw new Error(name + " 含非法字符（引号或换行），请检查输入");
}

export function saveSetup({ baseUrl, apiKey, model, dataDir, gatewayPort = 8420 }) {
  assertYamlSafe(baseUrl, "baseUrl");
  assertYamlSafe(model, "model");
  assertYamlSafe(dataDir || defaultDataDir(), "dataDir");
  mkdirSync(CFG_DIR, { recursive: true });

  // 生成随机网关 API Key（v2 数据面用；v1 路由不强制）
  const gatewayApiKey = "amd-" + randomUUID().replaceAll("-", "");

  writeFileAtomic(path.join(CFG_DIR, "tdai-gateway.local.yaml"), generateYaml({ baseUrl, model, dataDir, port: gatewayPort }));
  writeFileAtomic(path.join(CFG_DIR, ".env"), `TDAI_LLM_API_KEY=${apiKey}\nTDAI_LLM_BASE_URL=${baseUrl}\nTDAI_LLM_MODEL=${model}\nTDAI_GATEWAY_API_KEY=${gatewayApiKey}\n`);

  const app = { setupDone: true, baseUrl, apiKey, model, dataDir: dataDir || defaultDataDir(), gatewayPort, gatewayApiKey, createdAt: new Date().toISOString() };
  writeFileAtomic(path.join(CFG_DIR, "app.json"), JSON.stringify(app, null, 2));
  return app;
}

// 增量更新 LLM 三项（Base URL / Key / 模型）——只替换 yaml 的 llm.baseUrl/model 行
// 与 .env 对应行，其余配置（everyNConversations 等手工调优项）原样保留
export function updateLlmConfig({ baseUrl, apiKey, model }) {
  assertYamlSafe(baseUrl, "baseUrl");
  assertYamlSafe(model, "model");
  mkdirSync(CFG_DIR, { recursive: true });

  const yamlPath = path.join(CFG_DIR, "tdai-gateway.local.yaml");
  if (existsSync(yamlPath)) {
    let yaml = readFileSync(yamlPath, "utf8");
    // 锚定 llm: 块内（惰性匹配到 llm 段第一个），避免误伤用户后加的 embedding.baseUrl 等
    // 函数式替换：字符串替换串里的 $& 与 $1 等会被当匹配文本展开，
    // 含 $ 的 baseUrl/model/key 会被静默写坏（之后内核连不上 LLM，极难排查）
    yaml = yaml.replace(/(llm:[\s\S]*?baseUrl:\s*")[^"]*(")/, (m, p1, p2) => p1 + baseUrl + p2);
    yaml = yaml.replace(/(llm:[\s\S]*?model:\s*")[^"]*(")/, (m, p1, p2) => p1 + model + p2);
    writeFileAtomic(yamlPath, yaml);
  }

  const envPath = path.join(CFG_DIR, ".env");
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const envSet = (k, v) => env.includes(k + "=")
    ? (env = env.replace(new RegExp(k.replace(/[-_]/g, "\\$&") + "=.*"), () => `${k}=${v}`)) // 函数式替换防 $ 展开；必须赋回 env，否则改已存在的 key 静默无效
    : (env += `${k}=${v}\n`);
  envSet("TDAI_LLM_API_KEY", apiKey);
  envSet("TDAI_LLM_BASE_URL", baseUrl);
  envSet("TDAI_LLM_MODEL", model);
  writeFileAtomic(envPath, env);

  const appPath = path.join(CFG_DIR, "app.json");
  let app = {};
  try { app = JSON.parse(readFileSync(appPath, "utf8")); } catch { /* 首次无 app.json 走 saveSetup */ }
  app.baseUrl = baseUrl; app.apiKey = apiKey; app.model = model;
  app.updatedAt = new Date().toISOString();
  writeFileAtomic(appPath, JSON.stringify(app, null, 2));
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
  writeFileAtomic(appPath, JSON.stringify(app, null, 2));
  return app;
}
