#!/usr/bin/env python3
"""HTTP (streamable) 传输入口：给只支持 HTTP URL 的客户端（如豆包「自定义连接器」）用。

stdio 入口仍是 mcp_agent_memory.py（WorkBuddy / TRAE / Claude Desktop 的既有配置不变）。
本文件只是把同一个 MCP 实例改用 streamable HTTP 传输暴露：

    python mcp_http_bridge.py          # 监听 127.0.0.1:8410，端点 http://127.0.0.1:8410/mcp

环境变量：TDAI_HTTP_BRIDGE_HOST / TDAI_HTTP_BRIDGE_PORT 可改监听地址（默认 127.0.0.1:8410）。
工具与 stdio 版完全一致（capture/recall/search/health），同样带入库前脱敏。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_agent_memory import mcp  # 复用同一实例与全部工具定义

HOST = os.environ.get("TDAI_HTTP_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TDAI_HTTP_BRIDGE_PORT", "8410"))


def _load_token() -> str:
    """静态 Bearer Token（#12 完整版）：零鉴权时本机任意登录用户都能 curl 读写
    全部记忆。优先级：环境变量 TDAI_HTTP_BRIDGE_TOKEN > app.json 的 gatewayApiKey。
    客户端连接器 Headers 填 Authorization: Bearer <token>，不再留空。"""
    t = os.environ.get("TDAI_HTTP_BRIDGE_TOKEN")
    if t:
        return t
    try:
        cfg_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "data", "config", "app.json"
        )
        with open(cfg_path, encoding="utf-8") as f:
            return (json.load(f).get("gatewayApiKey") or "")
    except Exception:
        return ""

mcp.settings.host = HOST
mcp.settings.port = PORT

if __name__ == "__main__":
    # #12 最小版（自用）：回环绑定硬约束 + Host 头白名单，
    # 断掉两条暴露面——TDAI_HTTP_BRIDGE_HOST 绑非回环（局域网敞开）/ DNS rebinding
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print(f"[agent-memory http bridge] 拒绝启动：只允许绑定回环地址（当前 {HOST}）", file=sys.stderr, flush=True)
        sys.exit(2)
    TOKEN = _load_token()
    if not TOKEN:
        print("[agent-memory http bridge] 拒绝启动：未配置 Bearer Token（设 TDAI_HTTP_BRIDGE_TOKEN，或先完成首启向导生成 gatewayApiKey）", file=sys.stderr, flush=True)
        sys.exit(2)
    print(f"[agent-memory http bridge] listening on http://{HOST}:{PORT}/mcp", flush=True)
    try:
        import uvicorn
        from starlette.types import ASGIApp, Receive, Scope, Send

        _ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}

        class _HostGuard:
            """Host 白名单中间件：非回环 Host 一律 403（DNS rebinding 防线）。

            包成中间件而不是裸函数：保留 Starlette lifespan，
            streamable-http 的 session manager 才能正常起。
            """

            def __init__(self, app: ASGIApp) -> None:
                self.app = app

            async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
                if scope.get("type") == "http":
                    headers = {k.decode("latin1"): v.decode("latin1") for k, v in (scope.get("headers") or [])}
                    host = headers.get("host", "").split(":")[0]
                    if host not in _ALLOWED_HOSTS:
                        await send({
                            "type": "http.response.start",
                            "status": 403,
                            "headers": [(b"content-type", b"text/plain; charset=utf-8")],
                        })
                        await send({"type": "http.response.body", "body": "forbidden host (loopback only)".encode("utf-8")})
                        return
                    # 静态 Bearer Token（#12 完整版）：缺失/错误一律 401
                    if headers.get("authorization") != "Bearer " + TOKEN:
                        await send({
                            "type": "http.response.start",
                            "status": 401,
                            "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"www-authenticate", b"Bearer")],
                        })
                        await send({"type": "http.response.body", "body": "missing or invalid bearer token".encode("utf-8")})
                        return
                await self.app(scope, receive, send)

        uvicorn.run(_HostGuard(mcp.streamable_http_app()), host=HOST, port=PORT)
    except ImportError:
        # 环境缺 uvicorn：回环约束已生效，但 Host 头校验降级——明确告警不装哑巴
        print("[agent-memory http bridge] 警告：uvicorn/starlette 不可用，Host 头校验降级", file=sys.stderr, flush=True)
        mcp.run(transport="streamable-http")
