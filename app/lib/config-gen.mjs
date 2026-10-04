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

// dataDir 安全校验：拦盘根、Windows 系统目录、本软件目录及其祖先后代——
// 这些路径一旦进 app.json，备份/卸载就会对整个目录树动手（灾难性误删的入口防线）
export function assertSafeDataDir(dir) {
  const p = path.resolve(String(dir || ""));
  if (p === path.parse(p).root) throw new Error("数据目录不能是盘根：" + p);
  const bad = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", process.env.WINDIR || "", process.env.PROGRAMFILES || ""];
  const appRoot = path.resolve(import.meta.dirname, "..", "..");
  for (const b of [...bad, appRoot]) {
    if (!b) continue;
    const bp = path.resolve(b);
    if (p === bp || p.startsWith(bp + path.sep) || bp.startsWith(p + path.sep)) {
      throw new Error("数据目录不允许使用该路径（系统目录或软件目录）：" + p);
    }
  }
}

// app.json 读取策略（#4）：不存在→可新建 {}；存在但解析失败（上次写入被截断）→
// 必须抛错拦住，否则 dataDir/sessionKey 等字段会被空对象整体覆盖抹掉
function readAppJsonForUpdate(p) {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error("app.json 已存在但解析失败（可能上次写入被截断）。为防丢字段已拒绝继续写入，请手动修复或重新走首启向导：" + p);
  }
}

// 替换 yaml llm: 段内的标量（#37）：先认双引号值、再认裸值，统一改写成双引号形式；
// 都没命中返回 hit:false 让调用方告警——旧版只认带引号，裸值被静默跳过造成 yaml/env 双源漂移
function replaceYamlScalar(yaml, key, value) {
  const re = key === "baseUrl"
    ? /(llm:[\s\S]*?baseUrl:\s*)("[^"]*"|[^"\r\n]+)/
    : /(llm:[\s\S]*?model:\s*)("[^"]*"|[^"\r\n]+)/;
  if (!re.test(yaml)) return { yaml, hit: false };
  return { yaml: yaml.replace(re, (m, p1) => p1 + '"' + value + '"'), hit: true };
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
  // 反斜杠也必须拒：YAML 双引号串里 \ 会转义掉闭引号，后续行被吞进字符串、配置静默损坏
  if (/[\r\n"\\]/.test(String(v))) throw new Error(name + " 含非法字符（引号/反斜杠/换行），请检查输入");
}

export function saveSetup({ baseUrl, apiKey, model, dataDir, gatewayPort = 8420 }) {
  assertYamlSafe(baseUrl, "baseUrl");
  assertYamlSafe(model, "model");
  assertYamlSafe(dataDir || defaultDataDir(), "dataDir");
  // dataDir 安全校验：盘根/系统目录/软件目录一律拒（卸错库、删错库的入口防线）
  assertSafeDataDir(dataDir || defaultDataDir());

  mkdirSync(CFG_DIR, { recursive: true });

  // read-modify-write：重跑向导不许抹掉 sessionKey/httpBridge 等既有字段；
  // app.json 已存在但解析失败时拒绝重写（此时覆盖=丢字段）
  const appPath = path.join(CFG_DIR, "app.json");
  let prev = null;
  if (existsSync(appPath)) {
    try { prev = JSON.parse(readFileSync(appPath, "utf8")); }
    catch { throw new Error("app.json 解析失败，已拒绝重写（防丢字段）。请先修复或删除该文件再跑向导：" + appPath); }
  }
  // 网关 Key 已存在则不重生成（换了会让已连接的桥 401）；首次才生成随机值
  const gatewayApiKey = prev?.gatewayApiKey || ("amd-" + randomUUID().replaceAll("-", ""));

  writeFileAtomic(path.join(CFG_DIR, "tdai-gateway.local.yaml"), generateYaml({ baseUrl, model, dataDir, port: gatewayPort }));
  writeFileAtomic(path.join(CFG_DIR, ".env"), `TDAI_LLM_API_KEY=${apiKey}\nTDAI_LLM_BASE_URL=${baseUrl}\nTDAI_LLM_MODEL=${model}\nTDAI_GATEWAY_API_KEY=${gatewayApiKey}\n`);

  const app = {
    ...(prev || {}),
    setupDone: true, baseUrl, apiKey, model,
    dataDir: dataDir || defaultDataDir(), gatewayPort, gatewayApiKey,
    createdAt: prev?.createdAt || new Date().toISOString(),
  };
  writeFileAtomic(appPath, JSON.stringify(app, null, 2));
  return app;
}

// 增量更新 LLM 三项（Base URL / Key / 模型）——只替换 yaml 的 llm.baseUrl/model 行
// 与 .env 对应行，其余配置（everyNConversations 等手工调优项）原样保留
export function updateLlmConfig({ baseUrl, apiKey, model, httpBridge }) {
  assertYamlSafe(baseUrl, "baseUrl");
  assertYamlSafe(model, "model");
  mkdirSync(CFG_DIR, { recursive: true });

  const yamlPath = path.join(CFG_DIR, "tdai-gateway.local.yaml");
  if (existsSync(yamlPath)) {
    let yaml = readFileSync(yamlPath, "utf8");
    // 锚定 llm: 块内（惰性匹配到 llm 段第一个），避免误伤用户后加的 embedding.baseUrl 等
    // 函数式替换：字符串替换串里的 $& 与 $1 等会被当匹配文本展开，
    // 含 $ 的 baseUrl/model/key 会被静默写坏（之后内核连不上 LLM，极难排查）
    for (const key of ["baseUrl", "model"]) {
      const r = replaceYamlScalar(yaml, key, key === "baseUrl" ? baseUrl : model);
      yaml = r.yaml;
      // 没命中必须响：否则 yaml/env 双源漂移无声发生
      if (!r.hit) console.warn("[config-gen] yaml 的 llm." + key + " 行未命中，请检查 " + yamlPath + " 的格式");
    }
    writeFileAtomic(yamlPath, yaml);
  }

  const envPath = path.join(CFG_DIR, ".env");
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  // 锚定行首（^KEY= + m 标志）：旧版 includes 子串匹配会把新值写进 # 注释行，真实行保持旧值
  const envSet = (k, v) => new RegExp("^" + k.replace(/[-_]/g, "\\$&") + "=", "m").test(env)
    ? (env = env.replace(new RegExp("^" + k.replace(/[-_]/g, "\\$&") + "=.*$", "m"), () => `${k}=${v}`)) // 函数式替换防 $ 展开；必须赋回 env，否则改已存在的 key 静默无效
    : (env += `${k}=${v}\n`);
  envSet("TDAI_LLM_API_KEY", apiKey);
  envSet("TDAI_LLM_BASE_URL", baseUrl);
  envSet("TDAI_LLM_MODEL", model);
  writeFileAtomic(envPath, env);

  const appPath = path.join(CFG_DIR, "app.json");
  const app = readAppJsonForUpdate(appPath); // 解析失败直接抛错，绝不用空对象覆盖
  app.baseUrl = baseUrl; app.apiKey = apiKey; app.model = model;
  if (httpBridge !== undefined) app.httpBridge = !!httpBridge;
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
  const app = readAppJsonForUpdate(appPath); // 解析失败直接抛错，绝不用空对象覆盖
  app.sessionKey = key;
  app.updatedAt = new Date().toISOString();
  writeFileAtomic(appPath, JSON.stringify(app, null, 2));
  return app;
}
