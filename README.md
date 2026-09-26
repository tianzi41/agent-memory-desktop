# AgentMemory Desktop

**本地优先的 AI 记忆系统 —— 让所有 Agent 软件共享一份记忆。**

TRAE、WorkBuddy、豆包、Claude Desktop……每个 AI 工具都有自己的对话，但记不住事。AgentMemory 在你电脑上跑一个记忆内核，任何支持 MCP 的客户端接进来，共用同一份记忆：它知道你偏好什么、在做什么项目、做过哪些决策。

数据全部留在本机（SQLite + 本地文件），只在你配置的 LLM 端点做记忆提炼；填入 API 即用，不依赖任何云服务。

## 特性

- **四层记忆架构**
  - `L0` 对话流水：原始问答原文，按日落盘
  - `L1` 原子记忆：从对话提炼的单条事实（偏好 / 决策 / 技术栈），可编辑可删除
  - `L2` 场景记忆：按主题归类的 MD 文件，内核自动维护
  - `L3` 用户画像：长期沉淀的用户理解，内核自动生成
- **首启向导**：填 Base URL / API Key / 模型名即用，自动生成内核配置与会话标识
- **记忆管理台**：L0 浏览搜索、L1 纠错删除、今日新增统计
- **批量导入**
  - MD 导入：聊天记录逐轮导入、普通文档按章节切块；导入前预览实际发送内容；密钥自动脱敏；逐轮等待提炼防丢批
  - 一键扫描本机 WorkBuddy / 千问工作区的 JSONL 会话，按项目合并导入
- **备份迁移**：整个记忆库打包 zip（停内核保证一致性），恢复前自动滚存后悔药
- **客户端接入**：MCP 配置一键写入 TRAE / WorkBuddy 等客户端；HTTP 桥支持只认 URL 的客户端（如豆包自定义连接器）
- **常驻自愈**：开机自启 + 看门狗，内核挂了自动拉起
- **MCP 工具**：`capture_conversation` / `recall_memory` / `search_memories` / `search_conversations` / `health_check`

## 架构

```
┌────────────────────────────────────────────────────────┐
│  AI 客户端（TRAE / WorkBuddy / 豆包 / Claude Desktop…）  │
└──────────┬─────────────────────────┬───────────────────┘
           │ stdio                   │ HTTP URL
┌──────────▼──────────┐   ┌──────────▼───────────┐
│ bridge/ (Python)    │   │ bridge/ HTTP 模式     │
│ mcp_agent_memory.py │   │ :8410/mcp            │
└──────────┬──────────┘   └──────────┬───────────┘
           └──────────┬──────────────┘
              ┌───────▼────────────────┐
              │ kernel/MemoryCore      │  Gateway :8420
              │ 四层记忆 + L1-L3 提炼   │  （TypeScript，tsx 直跑）
              └───────┬────────────────┘
              ┌───────▼────────────────┐
              │ app/ (Node 原生 http)   │  Web 控制台 :8430
              │ 向导/管理台/导入/备份   │
              └────────────────────────┘
```

| 目录 | 说明 |
|------|------|
| `app/` | Web 控制台：Node 原生 http，**零 npm 依赖**；`lib/` 下 11 个模块（向导配置、内核进程管理、导入管道、备份、自启、卸载等） |
| `kernel/MemoryCore/` | 记忆内核 Gateway：四层存储、L1 提炼管道、BM25 检索、persona 生成（TypeScript，`npm install` 后由 tsx 直接运行） |
| `bridge/` | MCP 桥：把 Gateway 能力暴露为标准 MCP 工具，stdio 与 streamable-HTTP 双入口 |
| `launcher.ps1` | Windows 一键启动（优先用包内便携 Node） |

## 快速开始

### 环境要求

- **Node.js ≥ 20**（用到原生 `fetch` / `AbortSignal.timeout`）
- **Python ≥ 3.10** + `pip install mcp`（仅 MCP 客户端接入需要；纯 Web 台可不装）
- Windows / macOS / Linux 均可运行（自启与看门狗为 Windows 特性）

### 步骤

```bash
# 1. 克隆
git clone https://github.com/tianzi41/agent-memory-desktop.git
cd agent-memory-desktop

# 2. 安装内核依赖（记忆引擎本体）
cd kernel/MemoryCore
npm install
cd ../..

# 3. 启动（Windows）
.\launcher.ps1
#    或跨平台直接：node app/server.mjs
```

浏览器打开 <http://127.0.0.1:8430>，按向导填入：

- **Base URL**：LLM 服务端点（如 `https://api.stepfun.com/step_plan/v1`）
- **API Key**：该服务的密钥（只落盘到本机 `data/config/`，不进任何远端）
- **模型名**：如 `step-3.7-flash`

保存后内核自动启动，控制台显示「内核运行中」即可用。

### 接入 AI 客户端

1. 控制台 → **客户端接入**：勾选已安装的客户端，点「写入勾选的客户端」（自动备份原配置，只动 agent-memory 一项）
2. 把「记忆规则」文本粘贴到该客户端的自定义指令 / 提示词设置
3. 只支持服务器 URL 的客户端（如豆包）：用 HTTP 桥 `http://127.0.0.1:8410/mcp`

多个客户端填**同一个 session_key**，记忆才会聚到同一空间。

## 端口

| 端口 | 服务 |
|------|------|
| 8430 | Web 控制台 |
| 8420 | 记忆内核 Gateway |
| 8410 | MCP HTTP 桥（豆包等用） |

全部仅监听 `127.0.0.1`。

## 安全设计

- **只在环回地址监听**，不暴露局域网；API 请求校验 `Origin` 头防 CSRF
- **导入脱敏**：MD / JSONL 导入与 MCP capture 入库前，自动识别并打码 API Key、Token、密码（`sk-`、`gh[pousr]_`、`AKIA`、`xox[bpars]-`、`key=value` 等形态）
- **配置隔离**：LLM 密钥只写本机 `data/config/.env` 与 `app.json`；本仓库 `.gitignore` 已排除 `data/`、`logs/`、`backup/`、`runtime/` 及各类 `.env` / `*.bak`
- **备份一致性**：导出前先停内核再打包，避免 SQLite 半状态

## 数据存放

默认数据目录为 `data/memory-tdai/`（向导可改）：SQLite 记忆库 + `conversations/日期.jsonl` 对话流水 + L2 场景 MD + L3 画像。整个目录拷走即完成迁移。

## 开发

```bash
node app/server.mjs        # 启动 Web 控制台（含内核自动拉起）
node --check app/server.mjs  # 语法检查
```

内核有独立测试体系：`cd kernel/MemoryCore && npm test`。

## 许可证

[MIT](LICENSE)
