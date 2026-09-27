#!/usr/bin/env python3
"""TencentDB-Agent-Memory MCP server (stdio).

把本地 Gateway(8420) 的记忆能力暴露为标准 MCP 工具，
任何支持 MCP 的 agent (WorkBuddy / Codex / Claude Desktop 等) 加一段配置即可零代码接入。

工具面（2026-09 合并）：
  agent_memory  唯一对外声明的工具，用 mode 分发 capture / recall / search / conversations
  其余 5 个旧名字（capture_conversation / recall_memory / search_memories /
  search_conversations / health_check）仍可调用，但不再出现在 tools/list。

为什么合并：MCP 的工具定义会随每个请求重新发给模型——5 个工具的 schema 每轮要花
700+ token，合并后约 400。已按旧名字配好的客户端不受影响：旧名字照常注册、照常可调，
只是不占每轮的 schema 预算（deja-vu 同款做法）。

依赖: mcp (Python SDK)，运行于隔离 venv。tdai_client.py 需与本文件同目录。
"""
from __future__ import annotations

import os
import sys
import json
import re
from typing import Annotated, Literal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tdai_client import TdaiMemory

from mcp.server.fastmcp import FastMCP
from pydantic import Field

GATEWAY_URL = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")
GATEWAY_KEY = os.environ.get("TDAI_GATEWAY_API_KEY")  # 本地 dev key; 跨 agent 共用同一 Gateway


# 只在 tools/list 里声明 agent_memory。旧 5 个名字仍注册在工具管理器里，
# call_tool 按名字查得到，所以老客户端继续能用；list_tools 过滤掉它们，
# 新客户端就只看到便宜的那一个 schema。
class _DeclaredOnlyFastMCP(FastMCP):
    async def list_tools(self):
        return [t for t in await super().list_tools() if t.name == "agent_memory"]


mcp = _DeclaredOnlyFastMCP("agent-memory")

# 入库前脱敏：与 Web 导入侧保持一致（只拦确定性命中率高的形态，
# 不做 hex/base64 弱匹配——对话里 URL/hash 多，误伤比漏拦更糟）
_REDACT_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[bpars]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\b(?:api[_-]?key|apikey|token|secret|passwd|password|pwd)\s*[:=]\s*[\"']?([A-Za-z0-9_\-]{16,})[\"']?", re.I),
]


def _redact(text: str) -> str:
    if not text:
        return text

    def _mask(m):
        s = m.group(0)
        return s if len(s) < 12 else s[:4] + "***REDACTED***" + s[-4:]

    for pattern in _REDACT_PATTERNS:
        text = pattern.sub(_mask, text)
    return text


def _client() -> TdaiMemory:
    return TdaiMemory(base_url=GATEWAY_URL, api_key=GATEWAY_KEY)


def _dump(obj) -> str:
    """紧凑 JSON。indent 只会增加 token，模型解析紧凑 JSON 毫无障碍
    （实测同一份 recall 结果：indent=2 414 字符 → 紧凑 326 字符，省 21%）。"""
    if obj is None:
        return "(empty)"
    if isinstance(obj, (dict, list)):
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return str(obj)


def _envelope(mode: str, payload) -> str:
    """统一返回信封，模型不必分三种格式猜。

    重点：recall 的失败信号在 body.code 里，而 HTTP 状态仍是 200——
    不归一的话模型会把空上下文当成"没有相关记忆"的正常结果，白跑一轮。
    """
    if not isinstance(payload, dict):
        return _dump({"status": "ok", "mode": mode, "results": payload})
    out = dict(payload)
    out["mode"] = mode
    out["status"] = "error" if payload.get("code") else "ok"
    count = payload.get("memory_count", payload.get("total"))
    if isinstance(count, int):
        out["count"] = count
    return _dump(out)


def _tool_error(mode: str, e: Exception) -> str:
    return _dump({"status": "error", "mode": mode, "message": str(e)})


def _validate(mode: str, session_key: str, query: str, user_content: str, assistant_content: str) -> None:
    """按 mode 校验必填项。

    参数都带默认值，schema 上看不出哪个 mode 该传什么，模型可能懒省事漏传；
    文字描述不保险，这里在代码层兜底，报错信息直接告诉它缺什么、怎么补。
    """
    if mode in ("capture", "recall") and not session_key.strip():
        raise ValueError(f"session_key 不能为空：mode={mode} 必须带 session_key（同机多个客户端共用同一个值）")
    if mode == "capture":
        missing = [n for n, v in (("user_content", user_content), ("assistant_content", assistant_content)) if not v.strip()]
        if missing:
            raise ValueError(f"mode=capture 缺少必填参数：{', '.join(missing)}")
    if mode in ("recall", "search", "conversations") and not query.strip():
        raise ValueError(f"mode={mode} 必须带 query（任务描述 / 关键词 / 文件路径 / 错误信息）")


# ---- 内部实现：旧工具与 agent_memory 共用，保证两个入口行为一致 ----
def _capture(session_key: str, user_content: str, assistant_content: str) -> str:
    try:
        r = _client().capture(
            session_key=session_key,
            user_content=_redact(user_content),
            assistant_content=_redact(assistant_content),
        )
        n = r.get("l0_recorded", 0) if isinstance(r, dict) else 0
        return f"已写入（L0 {n} 条，L1-L3 提炼已调度）"
    except Exception as e:
        return _tool_error("capture", e)


def _recall(query: str, session_key: str, top_k: int) -> str:
    try:
        return _envelope("recall", _client().recall(query=query, session_key=session_key, top_k=top_k))
    except Exception as e:
        return _tool_error("recall", e)


def _search(query: str, limit: int, type: str, scene: str) -> str:
    try:
        return _envelope("search", _client().search_memories(
            query=query, limit=limit, type=type or None, scene=scene or None))
    except Exception as e:
        return _tool_error("search", e)


def _conversations(query: str, session_key: str, limit: int) -> str:
    try:
        return _envelope("conversations", _client().search_conversations(
            query=query, session_key=session_key or None, limit=limit))
    except Exception as e:
        return _tool_error("conversations", e)


def _health() -> str:
    try:
        return _dump(_client().health())
    except Exception as e:
        return _tool_error("health", e)


# ---- 唯一对外声明的工具 ----
@mcp.tool()
def agent_memory(
    mode: Annotated[Literal["capture", "recall", "search", "conversations"], Field(description="操作类型")],
    session_key: str = Field(default="", description="会话标识（项目名/用户名）。同机多个客户端必须填同一个值，否则记忆不互通。capture、recall 必填"),
    query: str = Field(default="", description="任务描述、关键词、文件路径或错误信息；支持自然语言，不限字面匹配"),
    user_content: str = Field(default="", description="用户消息原文，capture 模式下不能为空"),
    assistant_content: str = Field(default="", description="助手回复原文，capture 模式下不能为空"),
    top_k: int = Field(default=5, description="recall 返回条数"),
    limit: int = Field(default=5, description="search / conversations 返回条数"),
    type: str = Field(default="", description="search 类型过滤：episodic 事件 / persona 画像 / instruction 指令，留空全部"),
    scene: str = Field(default="", description="search 场景标签过滤，留空全部"),
):
    """本地记忆系统唯一入口，所有记忆操作走这一个工具，按 mode 分发。

    capture 写入一轮对话，落 L0 并触发后台 L1-L3 分层提炼。
    recall 自顶向下召回（L3 画像→L2 场景→L1 原子→L0 原文），返回可直接用作背景的上下文。
    search 检索结构化记忆，核对偏好、决策、技术栈、项目约定。
    conversations 检索 L0 原始对话，核对当时具体怎么说的。

    capture 自动脱敏（密钥/令牌打码）。search 类每轮合计不超过 3 次，查不到就基于现有信息继续。
    """
    _validate(mode, session_key, query, user_content, assistant_content)
    if mode == "capture":
        return _capture(session_key, user_content, assistant_content)
    if mode == "recall":
        return _recall(query, session_key, top_k)
    if mode == "search":
        return _search(query, limit, type, scene)
    return _conversations(query, session_key, limit)


# ---- 旧名字：仍注册（老客户端照常可调），但被 list_tools 过滤、不占每轮 schema 预算 ----
@mcp.tool()
def capture_conversation(session_key: str, user_content: str, assistant_content: str) -> str:
    """写入一轮对话 (user + assistant)，触发 L0 落库与后台 L1-L3 分层抽取。

    Args:
        session_key: 会话标识 (如项目名称 / 用户名)，同 key 的对话会聚类到同一记忆空间
        user_content: 用户本轮说的话
        assistant_content: AI 本轮的回复
    """
    return _capture(session_key, user_content, assistant_content)


@mcp.tool()
def recall_memory(query: str, session_key: str, top_k: int = 5) -> str:
    """自顶向下召回相关记忆 (L3 用户画像 -> L0 原始)，返回可直接注入系统提示的上下文。

    Args:
        query: 当前任务的自然语言描述 (用于检索相关性)
        session_key: 会话标识，限定检索范围
        top_k: 返回条目数
    """
    return _recall(query, session_key, top_k)


@mcp.tool()
def search_memories(query: str, limit: int = 5, type: str = "", scene: str = "") -> str:
    """检索结构化记忆 (L1 原子记忆 / L2 场景记忆 / L3 用户画像)。

    Args:
        query: 检索关键词
        limit: 返回条数
        type: 可选过滤 (episodic/persona/instruction)
        scene: 可选场景标签过滤
    """
    return _search(query, limit, type, scene)


@mcp.tool()
def search_conversations(query: str, session_key: str = "", limit: int = 5) -> str:
    """检索历史原始对话片段 (L0)。

    Args:
        query: 检索关键词
        session_key: 可选，限定会话
        limit: 返回条数
    """
    return _conversations(query, session_key, limit)


@mcp.tool()
def health_check() -> str:
    """Gateway 健康检查。"""
    return _health()


if __name__ == "__main__":
    mcp.run()
