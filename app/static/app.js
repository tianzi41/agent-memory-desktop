// app.js — AgentMemory Desktop 前端（原生 JS，零构建）
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 时间显示统一转本地时区（内核存的是 UTC，直接切片会差 8 小时）；兼容 ISO 字符串与毫秒数字
const fmtTime = (t) => {
  if (t === undefined || t === null || t === "") return "";
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t).slice(0, 19).replace("T", " ");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

let modelTested = false;
let injected = false;

// ---------- 初始化 ----------
async function init() {
  const s = await api("/api/status");
  $("headerStatus").textContent = s.gateway.healthy ? "内核运行中" : "内核未运行";
  $("headerStatus").className = "header-status " + (s.gateway.healthy ? "ok" : "bad");
  if (s.setupDone) { showConsole(s); } else { showWizard(); }
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}
function post(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
}

// ---------- 向导 ----------
function showWizard() {
  $("wizard").classList.remove("hidden");
  $("console").classList.add("hidden");
  loadClients();
  fetch("/api/trae-config").then(r => r.json()).then(d => { $("traeJson").textContent = d.text; $("traeJson2").textContent = d.text; });
}

function gotoStep(n) {
  [1, 2, 3].forEach(i => {
    $("step" + i).classList.toggle("hidden", i !== n);
    document.querySelector(`.step[data-s="${i}"]`).classList.toggle("active", i === n);
  });
}

$("provider").addEventListener("change", () => {
  if ($("provider").value === "custom") { $("baseUrl").value = ""; $("model").value = ""; }
  else { $("baseUrl").value = "https://api.siliconflow.cn/v1"; $("model").value = "Qwen/Qwen3-VL-8B-Instruct"; }
  modelTested = false; $("toStep2").disabled = true;
});

["baseUrl", "model", "apiKey"].forEach(id => $(id).addEventListener("input", () => {
  modelTested = false; $("toStep2").disabled = true; $("testResult").textContent = "";
}));

$("testModelBtn").addEventListener("click", async () => {
  const el = $("testResult");
  el.className = "test-result"; el.textContent = "测试中…（最长 30 秒）";
  const d = await post("/api/test-model", { baseUrl: $("baseUrl").value.trim(), apiKey: $("apiKey").value.trim(), model: $("model").value.trim() });
  if (d.ok) {
    el.className = "test-result ok"; el.textContent = `✅ 连接成功，延迟 ${d.ms}ms`;
    modelTested = true; $("toStep2").disabled = false;
  } else {
    el.className = "test-result bad"; el.textContent = `❌ 失败（${d.ms}ms）：${d.error}`;
  }
});

$("toStep2").addEventListener("click", () => gotoStep(2));
$("back1").addEventListener("click", () => gotoStep(1));
$("toStep3").addEventListener("click", () => gotoStep(3));

async function loadClients() {
  const clients = await api("/api/clients");
  const box = $("clientList");
  box.innerHTML = "";
  for (const [id, c] of Object.entries(clients)) {
    const div = document.createElement("div");
    div.className = "client-item" + (c.installed ? "" : " miss");
    const canCheck = c.injectable && c.installed;
    div.innerHTML = `
      <input type="checkbox" id="cb-${id}" ${canCheck ? "" : "disabled"}>
      <span class="name">${c.name}</span>
      <span class="note">${c.installed ? (c.injectable ? "已安装 · 支持自动写入" + (c.note ? " · " + c.note : "") : (c.note || "")) : "未安装"}</span>`;
    box.appendChild(div);
    if (id === "trae") {
      const cb = div.querySelector("input");
      cb.checked = true; cb.disabled = true; // TRAE 恒展示手动配置
      cb.addEventListener("change", () => $("traeBox").classList.toggle("hidden", !cb.checked));
      $("traeBox").classList.remove("hidden");
    }
  }
}

$("copyTrae").addEventListener("click", () => copyText($("traeJson").textContent, "copyOk"));
$("copyTrae2").addEventListener("click", () => copyText($("traeJson2").textContent));
$("showTrae").addEventListener("click", async () => {
  if (!$("traeJson2").textContent.trim()) {
    const d = await api("/api/trae-config");
    $("traeJson2").textContent = d.text;
  }
  $("traeModal").classList.toggle("hidden");
});

// 记忆系统规则（按 session_key 动态生成，粘贴到客户端自定义指令用）
let currentSessionKey = "default";
function memoryRules(key) {
  return `【记忆系统规则】
你已接入本地记忆系统（腾讯 Agent Memory，通过 MCP 工具调用）。所有记忆操作都走 agent_memory 一个工具，用 mode 区分。
1. 会话开始时，调 agent_memory（mode=recall，query 用当前任务的自然语言描述，session_key 固定使用 ${key}）注入相关历史记忆作为背景。
2. 到点就查，不等用户问——命中以下时机先 recall 再动作：
   a. 准备创建或修改某个文件前：query 用该文件路径；
   b. 命令执行失败时：query 用错误信息；
   c. 用户切换任务或主题时：query 用新主题，不要沿用上一个任务的背景。
3. 需要背景知识时用 mode=search 检索结构化记忆；当用户提及"之前/上次/以前/还记得"等指代词，或需核对原话时，用 mode=conversations 检索原始对话。
4. 对话中出现跨会话有用的事实（偏好、决策、技术栈、项目约定、长期指令），用 mode=capture 保存（user_content 与 assistant_content 都要传），session_key 固定使用 ${key}；保存内容中的文件路径一律用正斜杠（如 Q:/xxx），禁止反斜杠。
5. 检索使用语义关键词，不限于字面匹配；记忆仅作上下文，不要对外复述"我查了记忆"。
6. 临时/一次性信息不必存；被推翻的旧指令优先用新指令覆盖或显式标记失效。
7. search 类操作每轮合计调用不超过 3 次；无结果就直接基于现有信息回答，不要继续搜。
8. 能力边界：你只能写入（capture）和检索（recall/search）记忆。编辑、删除、按类型过滤等管理操作本工具不支持——用户提出这类需求时，请引导他去记忆软件的管理网页（http://127.0.0.1:8430）操作，不要假装已完成。`;
}

$("showRule").addEventListener("click", () => {
  const p = $("ruleText");
  if (!p.textContent.trim()) p.textContent = memoryRules(currentSessionKey);
  $("ruleBox").classList.toggle("hidden");
});
$("copyRule").addEventListener("click", () => copyText(memoryRules(currentSessionKey), "ruleCopyOk"));

// 会话标识（session_key）：加载当前值 + 保存后规则文本随之更新
async function loadSessionKey() {
  const d = await api("/api/session-key").catch(() => null);
  if (d?.key) { currentSessionKey = d.key; $("sessionKeyInput").value = d.key; }
}
$("sessionKeySave").addEventListener("click", async () => {
  const v = $("sessionKeyInput").value.trim();
  if (!v) { alert("标识不能为空"); return; }
  const r = await post("/api/session-key", { key: v });
  if (r.error) { alert(r.error); return; }
  currentSessionKey = r.key;
  $("ruleText").textContent = ""; // 清空缓存，下次"显示记忆规则"时用新 key 重新生成
  alert(`已保存：session_key = ${r.key}\n规则文本已更新，点"显示记忆规则"可复制新版。`);
});

// 逐个勾选写入客户端 MCP 配置
async function renderInjectPick() {
  const box = $("injectPick");
  if (!box) return;
  const clients = await api("/api/clients").catch(() => ({}));
  box.innerHTML = "";
  let any = false;
  for (const [id, c] of Object.entries(clients)) {
    if (!c.installed || !c.injectable) continue;
    any = true;
    const div = document.createElement("div");
    div.className = "client-item";
    div.innerHTML = `
      <input type="checkbox" id="icb-${id}" checked>
      <span class="name">${c.name}</span>
      <span class="note">${c.note || "已安装"}</span>`;
    box.appendChild(div);
  }
  if (!any) box.innerHTML = "<p class='dim'>未检测到可自动写入的客户端（Cursor / Claude Desktop / WorkBuddy 均未安装）</p>";
  $("injectBtn").disabled = !any;
}

$("injectBtn").addEventListener("click", async () => {
  const out = $("injectResult");
  const ids = [...document.querySelectorAll("#injectPick input:checked")].map(cb => cb.id.replace("icb-", ""));
  if (!ids.length) { out.innerHTML = "先勾选要写入的客户端"; return; }
  out.textContent = "写入中…";
  const d = await post("/api/inject", { clients: ids });
  const lines = Object.entries(d.results || {}).map(([id, r]) => {
    const nm = document.querySelector(`#icb-${id}`)?.closest(".client-item")?.querySelector(".name")?.textContent || id;
    return r.ok
      ? `✅ ${nm}：已写入 ${r.file}${r.backup ? "（原文件已备份到 backup 目录）" : ""}`
      : `❌ ${nm}：${r.error || "失败"}`;
  });
  if (d.results?.workbuddy?.ok) lines.push("⚠️ WorkBuddy 还需到 连接器管理 → 自定义连接 对 agent-memory 点「信任」后生效");
  out.innerHTML = lines.join("<br>");
});

renderInjectPick();

// ---------- 备份 / 迁移 ----------
async function refreshBackupInfo() {
  const s = await api("/api/status").catch(() => null);
  const el = $("backupDataDir");
  if (el && s?.dataDir) el.textContent = s.dataDir;
}

$("exportBtn").addEventListener("click", async () => {
  const out = $("backupResult");
  if (!confirm("导出记忆库？\n\n会先停止内核 → 打包数据目录 → 自动重启内核，全程约 10-30 秒。")) return;
  $("exportBtn").disabled = true;
  out.textContent = "正在停止内核并打包…（请勿关闭页面）";
  const d = await post("/api/backup/export", {});
  $("exportBtn").disabled = false;
  if (!d.ok) { out.innerHTML = `<span class="bad">❌ ${esc(d.error)}</span>`; return; }
  out.innerHTML = `✅ 已打包 ${esc(d.name)}（${d.sizeKB} KB，内核已重启）· 开始下载…`;
  // 触发浏览器下载
  const a = document.createElement("a");
  a.href = "/backup/" + encodeURIComponent(d.name);
  a.download = d.name;
  a.click();
});

$("importBackupBtn").addEventListener("click", () => $("restoreFile").click());
$("restoreFile").addEventListener("change", async () => {
  const f = $("restoreFile").files[0];
  if (!f) return;
  const out = $("backupResult");
  if (!confirm(`确定用「${f.name}」恢复记忆库？\n\n当前记忆会被整体替换（恢复前自动滚存一份到 backup 目录，可手动找回）。此操作需要停内核，约 30-60 秒。`)) { $("restoreFile").value = ""; return; }
  out.textContent = "上传中…（文件较大时请耐心）";
  $("importBackupBtn").disabled = true;
  try {
    const buf = await f.arrayBuffer();
    out.textContent = "已上传，正在停止内核并恢复…";
    const r = await fetch("/api/backup/import", { method: "POST", body: buf });
    const d = await r.json();
    if (!d.ok) { out.innerHTML = `<span class="bad">❌ ${esc(d.error)}</span>`; return; }
    out.innerHTML = `✅ 恢复完成，内核已重启${d.rollback ? `（原记忆库滚存为 ${esc(d.rollback)}）` : ""}· 页面即将刷新`;
    setTimeout(() => location.reload(), 2000);
  } catch (e) {
    out.innerHTML = `<span class="bad">❌ 上传失败：${esc(String(e.message || e))}</span>`;
  } finally {
    $("importBackupBtn").disabled = false;
    $("restoreFile").value = "";
  }
});

refreshBackupInfo();

// ---------- 卸载 ----------
$("uninstallPlanBtn").addEventListener("click", async () => {
  const out = $("uninstallResult");
  out.textContent = "检查中…";
  const d = await api("/api/uninstall/plan").catch(() => null);
  if (!d?.ok) { out.innerHTML = '<span class="bad">❌ 检查失败</span>'; return; }
  const lines = [];
  lines.push(`客户端注入：${d.clients.length ? d.clients.map(c => `${c.name}${c.hasEntry ? "（有 agent-memory）" : "（无）"}`).join("、") : "无可注入客户端"}`);
  lines.push(`开机自启：${d.autostart.enabled ? "已启用（将移除 VBS 并停止守护）" : "未启用"}`);
  lines.push(`记忆数据：${d.dataExists ? `${d.dataDir}（约 ${d.dataSizeKB} MB，${$("uninstallRemoveData").checked ? "勾选了删除 → 将删除" : "保留"}）` : "无数据目录"}`);
  out.innerHTML = lines.join("<br>");
});

$("uninstallBtn").addEventListener("click", async () => {
  const out = $("uninstallResult");
  const removeData = $("uninstallRemoveData").checked;
  const msg = removeData
    ? "⚠️ 最后确认：将删除全部记忆数据（不可恢复）！\n\n确定继续卸载吗？（建议先取消勾选并导出备份）"
    : "确定卸载？\n\n将移除客户端配置、关闭开机自启、停止内核。记忆数据保留。";
  if (!confirm(msg)) return;
  if (removeData && !confirm("再次确认：记忆数据删除后无法恢复（除非有导出/滚存包）。真的删？")) return;
  $("uninstallBtn").disabled = true;
  out.textContent = "卸载中…";
  try {
    const r = await fetch("/api/uninstall", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeData }),
    });
    const d = await r.json();
    out.innerHTML = (d.steps || []).map(s => `${s.ok ? "✅" : "❌"} ${esc(s.step)}${s.detail ? " — " + esc(s.detail) : ""}`).join("<br>")
      + `<br><br><b>卸载完成。请手动删除软件文件夹：${esc(d.appDir || "")}</b>（然后可关闭本页面）`;
  } catch (e) {
    out.innerHTML = `<span class="bad">❌ 卸载请求失败（服务可能已停止）：${esc(String(e.message || e))}</span><br><b>请手动删除软件文件夹完成卸载。</b>`;
  } finally {
    $("uninstallBtn").disabled = false;
  }
});

loadSessionKey();

function copyText(text, okId) {
  navigator.clipboard.writeText(text).then(() => {
    if (okId) { $(okId).classList.remove("hidden"); setTimeout(() => $(okId).classList.add("hidden"), 1500); }
  });
}

$("toStep3").addEventListener("click", async () => {
  // 进步骤 3 前先执行注入
  const ids = [];
  document.querySelectorAll("#clientList input:checked").forEach(cb => ids.push(cb.id.replace("cb-", "")));
  if (ids.length) {
    const d = await post("/api/inject", { clients: ids });
    injected = Object.values(d.results).every(r => r.ok);
  }
  gotoStep(3);
});

$("finishBtn").addEventListener("click", async () => {
  const log = $("finishLog");
  $("finishBtn").disabled = true;
  log.textContent = "生成配置…\n";
  const d = await post("/api/setup", {
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    dataDir: $("dataDir").value.trim() || undefined,
  });
  if (!d.ok) { log.textContent += "❌ " + (d.error || "失败"); $("finishBtn").disabled = false; return; }
  log.textContent += d.kernel.reused ? "检测到已有内核在运行，直接复用\n" : "内核启动中…\n";
  const s = await api("/api/status");
  if (s.gateway.healthy) {
    log.textContent += "✅ 内核健康检查通过（127.0.0.1:" + (s.gatewayPort || 8420) + "）";
    $("doneBox").classList.remove("hidden");
  } else {
    log.textContent += "⚠️ 内核未就绪，请查看 logs/kernel.log";
    $("finishBtn").disabled = false;
  }
});

$("gotoConsole").addEventListener("click", () => location.reload());

// ---------- 控制台 ----------
async function showConsole(s) {
  $("wizard").classList.add("hidden");
  $("console").classList.remove("hidden");
  renderStatus(s);
  loadStats();
  loadL0List();
  // 直接进控制台时也要填充 TRAE 配置（向导流程之外 traeJson2 不会被动填充）
  fetch("/api/trae-config").then(r => r.json()).then(d => { $("traeJson").textContent = d.text; $("traeJson2").textContent = d.text; });
  // 恢复导入进度显示：服务端导入不随页面关闭而停，刷新后自动接管轮询
  fetch("/api/import/status").then(r => r.json()).then(s => {
    const recent = s.finishedAt && (Date.now() - new Date(s.finishedAt) < 10 * 60 * 1000);
    if (s.running || (s.total && recent && (s.phase === "done" || s.phase === "aborted"))) {
      $("importProgress").classList.remove("hidden");
      pollImport();
      if (s.running) importTimer = setInterval(pollImport, 2000);
    }
  });
  refreshAutostart();
}

function loadL0List() { $("l0Load").click(); }

function renderStatus(s) {
  const g = $("gatewayState");
  g.innerHTML = s.gateway.healthy
    ? `<span class="state-ok">● 运行中</span><div class="config-info">提炼任务：完成 ${s.gateway.detail?.pipeline?.tasksCompleted ?? "-"} / 失败 ${s.gateway.detail?.pipeline?.tasksFailed ?? "-"}</div>`
    : `<span class="state-bad">● 未运行</span>`;
  // 配置字段来自 app.json（用户可填/可被 CSRF 改），一律转义后再进 innerHTML，防 stored XSS
  $("configInfo").innerHTML = `模型：<b>${esc(s.model)}</b><br>端点：${esc(s.baseUrl)}<br>Key：${esc(s.apiKeyMasked)}<br>数据：${esc(s.dataDir)}`;
}

// 修改模型配置：打开表单时预填当前值（避免轮询刷新覆盖编辑中内容，只在打开瞬间填一次）
$("editCfgBtn").addEventListener("click", async () => {
  const form = $("cfgForm");
  if (form.classList.contains("hidden")) {
    const s = await api("/api/status");
    $("editBaseUrl").value = s.baseUrl || "";
    $("editApiKey").value = s.apiKey || "";
    $("editModel").value = s.model || "";
    form.classList.remove("hidden");
  } else {
    form.classList.add("hidden");
  }
});

$("testModelBtn2").addEventListener("click", async () => {
  const out = $("cfgTestResult");
  out.textContent = "测试中…";
  const d = await post("/api/test-model", {
    baseUrl: $("editBaseUrl").value.trim(),
    apiKey: $("editApiKey").value.trim(),
    model: $("editModel").value.trim(),
  });
  out.innerHTML = d.ok ? `<span class="state-ok">✅ 连通（${d.ms}ms）</span>` : `<span class="state-bad">❌ ${d.error || "失败"}（${d.ms}ms）</span>`;
});

$("saveCfgBtn").addEventListener("click", async () => {
  const baseUrl = $("editBaseUrl").value.trim(), apiKey = $("editApiKey").value.trim(), model = $("editModel").value.trim();
  if (!baseUrl || !apiKey || !model) { alert("三项都要填"); return; }
  if (!confirm("保存后将重启记忆内核（约 30-60 秒），继续？")) return;
  const out = $("cfgTestResult");
  out.textContent = "保存并重启内核中…";
  const d = await post("/api/config/update", { baseUrl, apiKey, model });
  if (d.ok) { out.innerHTML = `<span class="state-ok">✅ 已保存，内核重启中（${d.kernel?.ok ? "已拉起" : "启动中"}）</span>`; setTimeout(refresh, 4000); }
  else { out.innerHTML = `<span class="state-bad">❌ ${d.error || "失败"}</span>`; }
});

$("kernelStartBtn").addEventListener("click", async () => { await post("/api/kernel/start"); setTimeout(refresh, 2500); });
$("kernelStopBtn").addEventListener("click", async () => { await post("/api/kernel/stop"); setTimeout(refresh, 800); });

// 开机自启 + watchdog 开关
async function refreshAutostart() {
  const s = await api("/api/autostart");
  $("autostartBtn").checked = !!s.enabled;
  const st = $("autostartState");
  if (st) {
    st.textContent = s.enabled ? (s.trayRunning ? "· 运行中" : "· 已启用（托盘未运行）") : "· 已关闭";
    st.style.color = s.enabled ? "#22c55e" : "";
  }
}
$("autostartBtn").addEventListener("change", async () => {
  const enable = $("autostartBtn").checked;
  if (!confirm(enable ? "开启开机自启 + 进程守护？（启动文件夹加一个 vbs，随时可在这里关闭）" : "关闭开机自启并停止守护进程？")) { refreshAutostart(); return; }
  const r = await post("/api/autostart", { enable });
  if (r.error) { alert(r.error); }
  refreshAutostart();
});

async function refresh() {
  const s = await api("/api/status");
  $("headerStatus").textContent = s.gateway.healthy ? "内核运行中" : "内核未运行";
  $("headerStatus").className = "header-status " + (s.gateway.healthy ? "ok" : "bad");
  if (s.setupDone) renderStatus(s);
  refreshDaily();
  refreshHttpBridge(s);
}

// HTTP 桥状态（豆包等 URL 型客户端依赖它）
function refreshHttpBridge(s) {
  const el = $("httpBridgeState");
  if (!el || !s?.httpBridge) return;
  el.innerHTML = s.httpBridge.running
    ? `HTTP 桥（豆包用）：<span class="state-ok">● 运行中</span> ${esc(s.httpBridge.url)}`
    : `HTTP 桥（豆包用）：<span class="state-bad">● 未运行</span>（随本页面服务自动起停，重启软件即可恢复）`;
}

// 今日统计（L0 新增 / 提炼任务，跨天自动清零，关页面不丢）
async function refreshDaily() {
  const el = $("dailyStats");
  if (!el) return;
  const d = await api("/api/daily-stats").catch(() => null);
  if (!d) return;
  el.innerHTML =
    `今日新增 L0：<b>${d.l0Added}</b> 条 · 今日提炼：完成 <b>${d.tasksDone}</b> / 失败 <b>${d.tasksFailed}</b>`;
}

$("captureBtn").addEventListener("click", async () => {
  const c = $("testContent").value.trim();
  if (!c) return;
  const d = await post("/api/kernel/capture", { sessionKey: "desktop-selftest", userContent: c, assistantContent: "已记录。" });
  $("loopResult").textContent = d.l0_recorded !== undefined
    ? `已存入（L0 x${d.l0_recorded}），后台提炼中，约 1-2 分钟后可搜索`
    : JSON.stringify(d);
});

$("searchBtn").addEventListener("click", async () => {
  const q = $("testQuery").value.trim();
  if (!q) return;
  const d = await api("/api/kernel/search?q=" + encodeURIComponent(q));
  $("loopResult").textContent = typeof d.results === "string" ? d.results : JSON.stringify(d, null, 2);
});

// ---------- M2：MD 导入 ----------
let importTimer = null;

$("scanBtn").addEventListener("click", async () => {
  const dir = $("importDir").value.trim();
  if (!dir) return;
  $("scanResult").textContent = "扫描中…";
  const d = await post("/api/import/scan", { dir });
  if (d.error) { $("scanResult").innerHTML = `<span class="bad">❌ ${d.error}</span>`; return; }
  if (!d.total) { $("scanResult").innerHTML = "未发现 MD 文件（目录结构应为：会话目录/会话.md）"; return; }
  let html = `<label><input type="checkbox" id="selAll" checked> 全选（${d.total} 个文件，已导入的默认不勾选）</label><div class="file-list">`;
  d.sessions.forEach((s, i) => {
    const modeTag = s.mode === "doc" ? `<span class="tag-doc">文档</span>` : "";
    const unit = s.mode === "doc" ? "块" : "轮";
    const mark = s.changed ? `<span class="tag-changed">${unit}数已变化</span>`
      : s.imported ? `<span class="tag-imported">✅ 已导入</span>` : "";
    html += `<label class="file-item${s.imported && !s.changed ? " imported" : ""}">
      <input type="checkbox" class="fcb" data-f="${s.file.replace(/"/g, "&quot;")}" ${s.imported && !s.changed ? "" : "checked"}>
      ${s.name} <span class="dim">· ${s.rounds} ${unit} · ${s.sizeKB}KB</span> ${modeTag} ${mark}</label>`;
  });
  html += `</div><button id="previewBtn" class="secondary">预览前 3 个文件</button> <button id="importBtn" class="primary">开始导入</button>`;
  $("scanResult").innerHTML = html;
  $("selAll").addEventListener("change", () => document.querySelectorAll(".fcb").forEach(cb => cb.checked = $("selAll").checked));
  $("importBtn").addEventListener("click", startImportJob);
  $("previewBtn").addEventListener("click", previewSelected);
});

// 导入前预览：展示前 3 个文件实际将发送的内容（脱敏/切块/sessionKey 后）
async function previewSelected() {
  const files = [...document.querySelectorAll(".fcb:checked")].map(cb => cb.dataset.f);
  const box = $("previewResult");
  if (!files.length) { alert("先勾选要预览的文件"); return; }
  box.classList.remove("hidden");
  box.innerHTML = "解析中…";
  const d = await post("/api/import/preview", { files });
  if (d.error) { box.innerHTML = `<span class="bad">❌ ${esc(d.error)}</span>`; return; }
  let html = `<p class="hint">以下是将实际发送给记忆内核的内容（已脱敏、已切块）。共勾选 ${d.totalFiles} 个文件，预览前 ${d.files.length} 个：</p>`;
  for (const f of d.files) {
    const name = f.file.split(/[\\/]/).pop();
    if (f.error) { html += `<div class="preview-card"><div class="preview-head">${esc(name)}</div><span class="bad">❌ ${esc(f.error)}</span></div>`; continue; }
    const modeTag = f.mode === "doc" ? `<span class="tag-doc">文档</span>` : "";
    const redactBadge = f.redactHits > 0 ? `<span class="tag-changed">脱敏 ${f.redactHits} 处</span>` : "";
    html += `<div class="preview-card">
      <div class="preview-head">${esc(name)} ${modeTag} <span class="dim">· ${f.total} ${f.mode === "doc" ? "块" : "轮"}</span> ${redactBadge}</div>
      <div class="preview-key">session_key：<b>${esc(f.sessionKey)}</b></div>`;
    f.sample.forEach((r, i) => {
      html += `<div class="preview-round"><div class="preview-role">第 ${i + 1} ${f.mode === "doc" ? "块" : "轮"} · 用户侧</div><pre>${esc(r.user)}${r.userTruncated ? "\n……（预览截断）" : ""}</pre>
        <div class="preview-role">助手侧</div><pre>${esc(r.assistant)}${r.assistantTruncated ? "\n……（预览截断）" : ""}</pre></div>`;
    });
    html += `</div>`;
  }
  html += `<button id="previewClose" class="secondary">收起预览</button>`;
  box.innerHTML = html;
  $("previewClose").addEventListener("click", () => { box.classList.add("hidden"); box.innerHTML = ""; });
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function startImportJob() {
  const files = [...document.querySelectorAll(".fcb:checked")].map(cb => cb.dataset.f);
  if (!files.length) return;
  const d = await post("/api/import/start", { files });
  if (!d.ok) { alert(d.error); return; }
  $("importProgress").classList.remove("hidden");
  importTimer = setInterval(pollImport, 2000);
}

async function pollImport() {
  const s = await api("/api/import/status");
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const fname = s.currentFile.split(/[\\/]/).pop() || "";
  const phaseTxt = s.phase === "waiting_llm" ? "等待模型提炼…" : "喂入中";
  const failTxt = s.failures.length ? `<br><span class="bad">失败 ${s.failures.length} 批</span>` : "";
  const doneTxt = !s.running
    ? `<br><b>导入${s.phase === "done" ? "完成" : "已中止"}</b>${s.failures.length ? `，失败 ${s.failures.length} 批（可稍后重跑失败项目）` : "，无失败"}`
    : "";
  if ($("barFill")) $("barFill").style.width = pct + "%";
  if ($("progressText")) $("progressText").innerHTML =
    `文件 ${s.done}/${s.total}（${pct}%） · 当前：${fname} 第 ${s.currentRound} 轮 · ${phaseTxt}` + failTxt + doneTxt;
  if ($("toolBarFill")) $("toolBarFill").style.width = pct + "%";
  if ($("toolProgressText")) $("toolProgressText").innerHTML =
    `项目 ${s.done}/${s.total}（${pct}%） · 当前：${esc(fname)} 第 ${s.currentRound} 轮 · ${phaseTxt}` + failTxt + doneTxt;
  if (!s.running) clearInterval(importTimer);
}

$("abortBtn").addEventListener("click", () => post("/api/import/abort"));

// ---------- 从 WorkBuddy / Qwen 导入 ----------
let toolProjectMap = {}; // sessionKey -> project 对象

$("toolScanBtn").addEventListener("click", async () => {
  toolProjectMap = {};
  const box = $("toolScanResult");
  box.textContent = "扫描中（读取全部项目的消息数，可能需要几秒）…";
  const d = await api("/api/tool-import/scan");
  if (d.workbuddy?.error || d.qwen?.error || d.claude?.error) {
    box.innerHTML = (d.workbuddy?.error ? `<span class="bad">❌ WorkBuddy：${esc(d.workbuddy.error)}</span>` : "") +
      (d.qwen?.error ? `<br><span class="bad">❌ Qwen：${esc(d.qwen.error)}</span>` : "") +
      (d.claude?.error ? `<br><span class="bad">❌ Claude Code：${esc(d.claude.error)}</span>` : "");
    return;
  }
  const wb = d.workbuddy.projects || [];
  const qw = d.qwen.projects || [];
  const cc = d.claude.projects || [];
  if (!wb.length && !qw.length && !cc.length) { box.innerHTML = "未发现 WorkBuddy / Qwen / Claude Code 项目"; return; }
  const total = wb.length + qw.length + cc.length;
  let html = `<label><input type="checkbox" id="toolSelAll"> 全选（${total} 个项目，已导入的默认不勾选）</label>`;
  html += renderToolGroup("WorkBuddy", wb);
  html += renderToolGroup("Qwen Workspace", qw);
  html += renderToolGroup("Claude Code", cc);
  html += `<button id="toolImportBtn" class="primary">开始导入勾选项目</button>`;
  box.innerHTML = html;
  $("toolSelAll").addEventListener("change", () => {
    document.querySelectorAll(".tcb").forEach(cb => { if (!cb.disabled) cb.checked = $("toolSelAll").checked; });
  });
  $("toolImportBtn").addEventListener("click", startToolImportJob);
});

function renderToolGroup(title, projects) {
  if (!projects.length) return "";
  let html = `<div class="tool-group"><div class="tool-group-title">${title}（${projects.length} 个项目）</div><div class="file-list">`;
  for (const p of projects) {
    toolProjectMap[p.sessionKey] = p;
    const span = p.startTime && p.endTime ? ` ${fmtTime(p.startTime)} ~ ${fmtTime(p.endTime)}` : "";
    const mark = p.imported ? `<span class="tag-imported">✅ 已导入</span>` : "";
    html += `<label class="file-item${p.imported ? " imported" : ""}">
      <input type="checkbox" class="tcb" data-sk="${esc(p.sessionKey)}" ${p.imported ? "" : "checked"}>
      ${esc(p.project)} <span class="dim">· ${p.fileCount} 会话 · ${p.msgCount} 消息 · ${p.sizeKB}KB${span}</span> ${mark}</label>`;
  }
  html += `</div></div>`;
  return html;
}

async function startToolImportJob() {
  const keys = [...document.querySelectorAll(".tcb:checked")].map(cb => cb.dataset.sk);
  if (!keys.length) { alert("先勾选要导入的项目"); return; }
  const projects = keys.map(k => toolProjectMap[k]).filter(Boolean);
  if (!projects.length) return;
  const d = await post("/api/tool-import/start", { projects });
  if (!d.ok) { alert(d.error); return; }
  $("toolImportProgress").classList.remove("hidden");
  importTimer = setInterval(pollImport, 2000);
}

$("toolAbortBtn").addEventListener("click", () => post("/api/import/abort"));

// ---------- M3：记忆管理 ----------
let l1Offset = 0, l1Total = 0;
const L1_PAGE = 20;

async function loadStats() {
  const d = await api("/api/memories/stats");
  $("memStats").textContent = `L0 ${d.l0 ?? "-"} · L1 ${d.l1 ?? "-"} · L2 ${d.l2 ?? "-"}`;
}

document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
  ["l0", "l1", "l2", "l3"].forEach(k => $("tab-" + k).classList.toggle("hidden", k !== t.dataset.tab));
  if (t.dataset.tab === "l2") loadL2();
  if (t.dataset.tab === "l3") loadL3();
}));

async function loadL1(append) {
  if (!append) l1Offset = 0;
  const q = $("l1Query").value.trim();
  const type = $("l1Type").value;
  const p = new URLSearchParams({ limit: L1_PAGE, offset: l1Offset });
  if (q) p.set("q", q);
  if (type) p.set("type", type);
  const d = await api("/api/memories/l1?" + p);
  if (d.error) { $("l1List").innerHTML = `<span class="bad">❌ ${d.error}</span>`; return; }
  l1Total = d.data?.total ?? d.items?.length ?? 0;
  const items = d.data?.items ?? d.items ?? [];
  const html = items.map(m => `
    <label class="mem-item">
      <input type="checkbox" class="micb" data-id="${m.id}">
      <div class="mem-body">
        <div class="mem-head"><span class="tag">${m.type}</span><span class="dim">v${m.version} · ${fmtTime(m.updated_at)}</span><button class="mini edit-btn" data-id="${m.id}">编辑</button></div>
        <div class="mem-text" id="mt-${m.id}">${(m.content || "").replace(/</g, "&lt;")}</div>
        ${m.background ? `<div class="mem-bg">${m.background.replace(/</g, "&lt;")}</div>` : ""}
      </div>
    </label>`).join("");
  $("l1List").innerHTML = append ? $("l1List").innerHTML + html : (html || "<p class='dim'>暂无记忆</p>");
  l1Offset += items.length;
  $("l1More").classList.toggle("hidden", !(q || l1Offset < l1Total));
}

// L1 编辑（事件委托：编辑 / 保存 / 取消）
$("l1List").addEventListener("click", async e => {
  const editBtn = e.target.closest(".edit-btn");
  if (editBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = editBtn.dataset.id;
    const box = $("mt-" + id);
    if (!box) return;
    const cur = box.textContent;
    box.innerHTML = `<textarea class="edit-ta" rows="5"></textarea><div class="edit-ops"><button class="mini save-btn" data-id="${id}">保存</button><button class="mini cancel-btn">取消</button></div>`;
    box.querySelector("textarea").value = cur;
    box.querySelector("textarea").focus();
    return;
  }
  const saveBtn = e.target.closest(".save-btn");
  if (saveBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = saveBtn.dataset.id;
    const ta = $("mt-" + id)?.querySelector("textarea");
    if (!ta || !ta.value.trim()) return;
    const d = await post("/api/memories/l1/update", { id, content: ta.value.trim() });
    if (d.code === 0 || d.data?.id) { loadL1(false); }
    else alert("保存失败：" + (d.error?.message || d.error || JSON.stringify(d)));
    return;
  }
  const cancelBtn = e.target.closest(".cancel-btn");
  if (cancelBtn) { e.preventDefault(); e.stopPropagation(); loadL1(false); }
});

$("l1Load").addEventListener("click", () => loadL1(false));
$("l1Query").addEventListener("keydown", e => { if (e.key === "Enter") loadL1(false); });
$("l1MoreBtn").addEventListener("click", () => loadL1(true));

$("l1Delete").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".micb:checked")].map(cb => cb.dataset.id);
  if (!ids.length) { alert("先勾选要删除的 L1 记忆"); return; }
  if (!confirm(`确定删除 ${ids.length} 条 L1 记忆？此操作不可恢复。`)) return;
  const d = await post("/api/memories/l1/delete", { ids });
  if (d.data?.deleted_count !== undefined) { alert(`已删除 ${d.data.deleted_count} 条`); loadL1(false); loadStats(); }
  else alert("删除失败：" + (d.error?.message || d.error || JSON.stringify(d)));
});

$("l0Load").addEventListener("click", async () => {
  const q = $("l0Query").value.trim();
  const d = await api("/api/memories/l0?limit=10" + (q ? "&q=" + encodeURIComponent(q) : ""));
  if (d.error) { $("l0List").innerHTML = `<span class="bad">❌ ${d.error}</span>`; return; }
  const msgs = d.data?.messages ?? [];
  $("l0List").innerHTML = msgs.length ? msgs.map(m => `
    <div class="mem-item">
      <div class="mem-body">
        <div class="mem-head"><span class="tag">${m.role}</span><span class="dim">${m.score !== undefined ? "score " + m.score.toFixed(3) + " · " : ""}${fmtTime(m.timestamp || m.created_at)}</span></div>
        <div class="mem-text">${(m.content || "").slice(0, 400).replace(/</g, "&lt;")}</div>
      </div>
    </div>`).join("") : "<p class='dim'>暂无对话流水</p>";
});
$("l0Query").addEventListener("keydown", e => { if (e.key === "Enter") $("l0Load").click(); });

async function loadL2() {
  const d = await api("/api/memories/l2");
  if (d.error) { $("l2List").innerHTML = `<span class="bad">❌ ${d.error}</span>`; return; }
  const entries = d.data?.entries ?? [];
  $("l2List").innerHTML = entries.length ? entries.map(e => `
    <div class="mem-item clickable" data-path="${(e.path || "").replace(/"/g, "&quot;")}">
      <div class="mem-body">
        <div class="mem-head"><span class="tag">L2</span><span class="dim">${e.type || "file"}</span></div>
        <div class="mem-text">${e.path || ""}</div>
      </div>
    </div>`).join("") : "<p class='dim'>暂无场景文件（L2 由内核在多轮提炼后自动生成）</p>";
  $("l2List").querySelectorAll(".clickable").forEach(el => el.addEventListener("click", async () => {
    const r = await api("/api/memories/l2/read?path=" + encodeURIComponent(el.dataset.path));
    const box = $("l2Content");
    box.classList.remove("hidden");
    box.textContent = r.data?.content ?? r.error?.message ?? JSON.stringify(r.data ?? r, null, 2);
  }));
}

async function loadL3() {
  const d = await api("/api/memories/l3");
  $("l3Content").textContent = d.data?.content || "暂无画像内容（L3 由内核在长期使用中自动沉淀，L2 场景积累后生成）";
}

init();
setInterval(refresh, 10000);
