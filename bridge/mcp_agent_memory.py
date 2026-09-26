#!/usr/bin/env python3
"""TencentDB-Agent-Memory MCP server (stdio).

把本地 Gateway(8420) 的记忆能力暴露为标准 MCP 工具，
任何支持 MCP 的 agent (WorkBuddy / Codex / Claude Desktop 等) 加一段配置即可零代码接入。

工具:
  capture_conversation  - 写入一轮 user+assistant，触发 L0 落库与后台 L1-L3 抽取
  recall_memory         - 自顶向下召回 (L3 用户画像 -> L0 原始)，返回可注入上下文
  search_memories       - 检索结构化记忆 (L1 原子 / L2 场景 / L3 画像)
  search_conversations  - 检索原始对话片段
  health_check          - Gateway 健康检查

依赖: mcp (Python SDK)，运行于隔离 venv。tdai_client.py 需与本文件同目录。
"""
from __future__ import annotations

import os
import sys
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tdai_client import TdaiMemory

from mcp.server.fastmcp import FastMCP

GATEWAY_URL = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")
GATEWAY_KEY = os.environ.get("TDAI_GATEWAY_API_KEY")  # 本地 dev key; 跨 agent 共用同一 Gateway

mcp = FastMCP("agent-memory")

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
    if obj is None:
        return "(empty)"
    if isinstance(obj, (dict, list)):
        return json.dumps(obj, ensure_ascii=False, indent=2)
    return str(obj)


@mcp.tool()
def capture_conversation(session_key: str, user_content: str, assistant_content: str) -> str:
    """写入一轮对话 (user + assistant)，触发 L0 落库与后台 L1-L3 分层抽取。

    Args:
        session_key: 会话标识 (如项目名称 / 用户名)，同 key 的对话会聚类到同一记忆空间
        user_content: 用户本轮说的话
        assistant_content: AI 本轮的回复
    """
    try:
        r = _client().capture(
            session_key=session_key,
            user_content=_redact(user_content),
            assistant_content=_redact(assistant_content),
        )
        return _dump(r)
    except Exception as e:
        return f"[capture error] {e}"


@mcp.tool()
def recall_memory(query: str, session_key: str, top_k: int = 5) -> str:
    """自顶向下召回相关记忆 (L3 用户画像 -> L0 原始)，返回可直接注入系统提示的上下文。

    Args:
        query: 当前任务的自然语言描述 (用于检索相关性)
        session_key: 会话标识，限定检索范围
        top_k: 返回条目数
    """
    try:
        r = _client().recall(query=query, session_key=session_key, top_k=top_k)
        return _dump(r)
    except Exception as e:
        return f"[recall error] {e}"


@mcp.tool()
def search_memories(query: str, limit: int = 5, type: str = "", scene: str = "") -> str:
    """检索结构化记忆 (L1 原子记忆 / L2 场景记忆 / L3 用户画像)。

    Args:
        query: 检索关键词
        limit: 返回条数
        type: 可选过滤 (atomic/scene/persona)
        scene: 可选场景标签过滤
    """
    try:
        r = _client().search_memories(
            query=query,
            limit=limit,
            type=type or None,
            scene=scene or None,
        )
        return _dump(r)
    except Exception as e:
        return f"[search_memories error] {e}"


@mcp.tool()
def search_conversations(query: str, session_key: str = "", limit: int = 5) -> str:
    """检索历史原始对话片段 (L0)。

    Args:
        query: 检索关键词
        session_key: 可选，限定会话
        limit: 返回条数
    """
    try:
        r = _client().search_conversations(
            query=query,
            session_key=session_key or None,
            limit=limit,
        )
        return _dump(r)
    except Exception as e:
        return f"[search_conversations error] {e}"


@mcp.tool()
def health_check() -> str:
    """Gateway 健康检查。"""
    try:
        return _dump(_client().health())
    except Exception as e:
        return f"[health error] {e}"


if __name__ == "__main__":
    mcp.run()
