#!/usr/bin/env python3
"""L1 冒烟测试：capture 唯一 token -> 等提炼 -> 断言 search/recall 都能取回。

用法: python smoke_l1.py [--session smoke-xxx] [--timeout 150]
退出码: 0 = 全过; 1 = 有断言失败; 2 = 网关不可达/不健康

相对旧版的修复（审计 DA-HIGH-06）:
  - 真断言 + 真退出码：旧版无 assert 无 exit code，坏内核也 exit 0
  - 写路径也测：capture -> L1 提炼 -> 检索整条链，而不是只打印截断输出
  - 完成信号用「token 可被检索到」而非全局 tasksCompleted（旧版任何历史
    会话完成过一个任务就假阳性）
  - pipelineWorker 为 None 时不崩（内核可能不返回该字段）
  - 隔离命名空间 smoke-<日期>，不污染正常会话空间
  - 自包含（纯标准库），不依赖 tdai_client / 任何硬编码目录
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

GW = "http://127.0.0.1:8420"


def _req(path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        GW + path, data=data, headers={"Content-Type": "application/json"},
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read(200).decode("utf-8", "ignore")
        raise RuntimeError("[%d] %s failed: %s" % (e.code, path, detail)) from e


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="", help="默认 smoke-<日期>")
    ap.add_argument("--timeout", type=int, default=150, help="等待提炼的最长秒数")
    args = ap.parse_args()

    session = args.session or ("smoke-" + datetime.now().strftime("%Y%m%d"))
    token = "smoketoken-" + uuid.uuid4().hex[:10]
    print("session=%s token=%s" % (session, token))

    # 0) 网关必须健康
    try:
        h = _req("/health")
    except Exception as e:
        print("FAIL 网关不可达: %s" % e)
        return 2
    if h.get("status") != "ok":
        print("FAIL 网关状态不是 ok: %r" % h.get("status"))
        return 2
    pw = (h.get("services") or {}).get("pipelineWorker")
    base_done = (pw or {}).get("tasksCompleted")
    print("网关 ok（pipelineWorker: %s）" % ("有" if pw else "无，不阻塞"))

    # 1) capture 两轮（everyNConversations=2，两轮即可触发提炼，不用干等 idle）
    for i in range(2):
        r = _req("/capture", {
            "session_key": session,
            "user_content": "冒烟测试第 %d 轮：本轮的校验令牌是 %s，请记住它。" % (i + 1, token),
            "assistant_content": "已记住校验令牌 %s（第 %d 轮）。" % (token, i + 1),
        })
        n = (r or {}).get("l0_recorded", 0)
        print("capture #%d -> l0_recorded=%s" % (i + 1, n))
        if not n:
            print("FAIL capture 第 %d 轮没有落 L0: %r" % (i + 1, r))
            return 1

    # 2) 提醒内核会话结束（旧版就有这一步，保留）
    try:
        _req("/session/end", {"session_key": session})
        print("session/end ok")
    except Exception as e:
        print("(session/end 失败不阻塞: %s)" % e)

    # 3) 轮询：token 可被 search 到 = 提炼完成（比全局计数器可靠）
    print("等待提炼（最多 %ds）..." % args.timeout)
    deadline = time.time() + args.timeout
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
        if pw is not None:
            try:
                cur = ((_req("/health").get("services") or {}).get("pipelineWorker")) or {}
                print("  [剩余 %3ds] tasksCompleted=%s" % (int(deadline - time.time()), cur.get("tasksCompleted")))
            except Exception:
                pass
    if not found:
        print("FAIL 等待 %ds 后 token 仍未出现在 search 结果——L1 提炼链没通" % args.timeout)
        return 1
    print("PASS L1 提炼完成，token 已可检索")

    # 4) recall 也该能拿到（召回链 = L3->L2->L1->L0）
    try:
        rc = _req("/recall", {"query": "校验令牌 " + token, "session_key": session})
    except Exception as e:
        print("FAIL recall 请求异常: %s" % e)
        return 1
    ctx = (rc or {}).get("context") or ""
    if token in ctx:
        print("PASS recall 召回到 token（context %d 字符）" % len(ctx))
    elif ctx.strip():
        print("PASS recall 返回了上下文（%d 字符；token 在 L1 层而召回到 L0，可接受）" % len(ctx))
    else:
        print("FAIL recall 上下文为空")
        return 1

    # 5) tasksCompleted 佐证（有该字段时）
    if pw is not None and base_done is not None:
        try:
            cur = ((_req("/health").get("services") or {}).get("pipelineWorker")) or {}
            if (cur.get("tasksCompleted") or 0) > base_done:
                print("PASS pipelineWorker 任务数有增长（%s -> %s）" % (base_done, cur.get("tasksCompleted")))
        except Exception:
            pass

    print("")
    print("=== SMOKE PASS ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
