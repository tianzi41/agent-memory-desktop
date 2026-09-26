#!/usr/bin/env python3
"""HTTP (streamable) 传输入口：给只支持 HTTP URL 的客户端（如豆包「自定义连接器」）用。

stdio 入口仍是 mcp_agent_memory.py（WorkBuddy / TRAE / Claude Desktop 的既有配置不变）。
本文件只是把同一个 MCP 实例改用 streamable HTTP 传输暴露：

    python mcp_http_bridge.py          # 监听 127.0.0.1:8410，端点 http://127.0.0.1:8410/mcp

环境变量：TDAI_HTTP_BRIDGE_HOST / TDAI_HTTP_BRIDGE_PORT 可改监听地址（默认 127.0.0.1:8410）。
工具与 stdio 版完全一致（capture/recall/search/health），同样带入库前脱敏。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_agent_memory import mcp  # 复用同一实例与全部工具定义

HOST = os.environ.get("TDAI_HTTP_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TDAI_HTTP_BRIDGE_PORT", "8410"))

mcp.settings.host = HOST
mcp.settings.port = PORT

if __name__ == "__main__":
    print(f"[agent-memory http bridge] listening on http://{HOST}:{PORT}/mcp", flush=True)
    mcp.run(transport="streamable-http")
