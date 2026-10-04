#!/usr/bin/env python3
"""HTTP 桥最小闭环自测：本地 Gateway 健康 -> capture 唯一 token -> search 断言。

退出码: 0 = 全过; 1 = 断言失败; 2 = 网关不可达。
旧版是 0 字节空文件——任何把它当门禁的脚本/CI 都得到"假通过"（审计 #33），
本文件补上真断言与真退出码。纯标准库、自包含。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

GW = "http://127.0.0.1:8420"
# 绕过系统代理（同 smoke_l1.py：代理机连本机都被送代理 = 假失败）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# 内核 l1-extractor 已知瞬态抖动：仅 no_json/empty_scenes 允许重试，最多 2 次
TRANSIENT_REASONS = {"no_json", "empty_scenes"}


def _last_empty_reason(session: str) -> str:
    """从内核日志读该 session 最近的 l1-empty 原因，判断失败是否瞬态。
    日志不可达返回 unknown——按非瞬态处理，绝不静默吞失败。"""
    import os

    for p in (os.environ.get("TDAI_KERNEL_LOG"),
              os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "kernel.log")):
        if not p or not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()[-500:]
        except Exception:
            continue
        reason = ""
        for ln in lines:
            if "l1-empty" in ln and session in ln:
                import re
                m = re.search(r"reason=(\w+)", ln)
                if m:
                    reason = m.group(1)
        return reason or "unknown"
    return "unknown"

def _req(path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        GW + path, data=data, headers={"Content-Type": "application/json"},
        method="POST" if data else "GET",
    )
    try:
        with _OPENER.open(req, timeout=30) as r:
            body = r.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read(200).decode("utf-8", "ignore")
        raise RuntimeError("[%d] %s failed: %s" % (e.code, path, detail)) from e


def main() -> int:
    session = "selftest-" + datetime.now().strftime("%Y%m%d")
    token = "selftoken-" + uuid.uuid4().hex[:10]
    try:
        h = _req("/health")
    except Exception as e:
        print("FAIL 网关不可达: %s" % e)
        return 2
    if h.get("status") != "ok":
        print("FAIL 网关状态不是 ok: %r" % h.get("status"))
        return 2
    print("网关 ok")
    try:
        r = _req("/capture", {
            "session_key": session,
            "user_content": "自测校验令牌 %s" % token,
            "assistant_content": "已记住 %s" % token,
        })
    except Exception as e:
        print("FAIL capture 异常: %s" % e)
        return 1
    if not (r or {}).get("l0_recorded"):
        print("FAIL capture 未落 L0: %r" % r)
        return 1
    print("capture ok")
    retries = 0
    reason = "none"
    while True:
        deadline = time.time() + 150
        found = False
        while time.time() < deadline:
            time.sleep(5)
            try:
                s = _req("/search/memories", {"query": token, "limit": 5})
            except Exception as e:
                print("(search 失败，继续等: %s)" % e)
                continue
            if token in json.dumps(s, ensure_ascii=False):
                found = True
                break
        if found:
            print("PASS token 已可检索——capture->提炼->search 链路通（reason=%s，重试 %d 次）" % (reason, retries))
            return 0
        reason = _last_empty_reason(session)
        if reason in TRANSIENT_REASONS and retries < 2:
            retries += 1
            print("瞬态失败 reason=%s，重试 %d/2（再 capture 一轮重新等）" % (reason, retries))
            try:
                r = _req("/capture", {
                    "session_key": session,
                    "user_content": "自测重试第 %d 轮：校验令牌 %s，请记住它。" % (retries, token),
                    "assistant_content": "已记住 %s（重试第 %d 轮）。" % (token, retries),
                })
                if not (r or {}).get("l0_recorded"):
                    print("FAIL 重试 capture 未落 L0: %r" % r)
                    return 1
            except Exception as e:
                print("FAIL 重试 capture 异常: %s" % e)
                return 1
            continue
        print("FAIL 150s 内 token 未出现在 search 结果（reason=%s，重试 %d 次）——%s" % (
            reason, retries,
            "瞬态重试超限" if reason in TRANSIENT_REASONS else "非瞬态失败"))
        return 1


if __name__ == "__main__":
    sys.exit(main())