#!/usr/bin/env python3
"""TencentDB-Agent-Memory Gateway 轻量客户端（字段对齐真实 API）。

Gateway 由 `npx tsx src/gateway/server.ts` 独立启动（端口 8420）。
路由与请求体（取自 src/gateway/server.ts）：
  GET  /health
  POST /capture               body: user_content*, assistant_content*, session_key*, [messages], [session_id]
  POST /recall                body: query*, session_key*            -> {context, strategy, memory_count}
  POST /search/memories       body: query*, [limit], [type], [scene]
  POST /search/conversations  body: query*, [session_key], [limit]
  POST /session/end           body: session_key*

注意：capture 只落 L0 原始日志；L1-L3 由后台 scheduler 异步抽取，
capture 后需等待片刻再 recall/search 才能看到分层结果。
"""
from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from typing import Any


class TdaiMemory:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        api_key: str | None = None,
        timeout: int = 120,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path, data=data, headers=self._headers(), method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")
            raise RuntimeError(f"[{e.code}] {path} failed: {detail}") from e
        return json.loads(body) if body else None

    def _get(self, path: str) -> Any:
        req = urllib.request.Request(self.base_url + path, headers=self._headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            body = resp.read().decode("utf-8")
        return json.loads(body) if body else None

    # ---- 健康检查 ----
    def health(self) -> dict[str, Any]:
        return self._get("/health")

    # ---- 写入：一轮 user+assistant，触发 L0 落库 + 异步 L1-L3 抽取 ----
    def capture(
        self,
        session_key: str,
        user_content: str,
        assistant_content: str,
        messages: list[dict[str, str]] | None = None,
        session_id: str | None = None,
    ) -> Any:
        payload: dict[str, Any] = {
            "session_key": session_key,
            "user_content": user_content,
            "assistant_content": assistant_content,
        }
        if messages:
            payload["messages"] = messages
        if session_id:
            payload["session_id"] = session_id
        return self._post("/capture", payload)

    # ---- 召回：自顶向下检索（L3 画像 -> L0 原始），返回可注入的系统上下文 ----
    def recall(self, query: str, session_key: str, top_k: int = 5) -> Any:
        return self._post("/recall", {"query": query, "session_key": session_key, "top_k": top_k})

    # ---- 检索记忆（L1/L2/L3 结构化记忆） ----
    def search_memories(
        self,
        query: str,
        limit: int = 5,
        type: str | None = None,
        scene: str | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"query": query, "limit": limit}
        if type:
            payload["type"] = type
        if scene:
            payload["scene"] = scene
        return self._post("/search/memories", payload)

    # ---- 检索原始对话 ----
    def search_conversations(self, query: str, session_key: str | None = None, limit: int = 5) -> Any:
        payload: dict[str, Any] = {"query": query, "limit": limit}
        if session_key:
            payload["session_key"] = session_key
        return self._post("/search/conversations", payload)


if __name__ == "__main__":
    m = TdaiMemory(
        base_url=os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420"),
        api_key=os.environ.get("TDAI_GATEWAY_API_KEY"),
    )
    print("health:", m.health())
