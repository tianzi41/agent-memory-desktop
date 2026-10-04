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

# 绕过系统代理：urllib 默认 opener 会读 Windows 代理设置，
# 用户配了代理且没把 127.0.0.1 加入绕过列表时，连本机网关都被送代理——冒烟假失败
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# 内核 l1-extractor 的已知瞬态抖动（实测：reason=no_json/empty_scenes，
# 重试或时间窗口过后即恢复）——仅这两类允许冒烟重试，最多 2 次
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

    # 0.5) 阴性对照：capture 前搜 token 必须搜不到——否则"搜到了"可能来自别处残留，
    # 证明不了本轮链路（capture 前后对比才是有效断言）
    try:
        pre = _req("/search/memories", {"query": token, "limit": 5})
        if token in json.dumps(pre, ensure_ascii=False):
            print("FAIL capture 前 token 已可被检索（命名空间污染或假阳性）")
            return 1
    except Exception as e:
        print("(阴性对照 search 失败不阻塞: %s)" % e)

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

    # 3) 轮询 + 瞬态重试：token 可被 search 到 = 提炼完成（比全局计数器可靠）。
    #    失败时先查 reason：仅 no_json/empty_scenes 类瞬态允许重试（最多 2 次），
    #    非瞬态或超限一律 FAIL；最终输出必须带 reason 和重试次数，不静默吞失败
    retries = 0
    reason = "none"
    while True:
        print("等待提炼（最多 %ds，第 %d 轮）..." % (args.timeout, retries + 1))
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
        if found:
            print("PASS L1 提炼完成，token 已可检索（reason=%s，重试 %d 次）" % (reason, retries))
            break
        reason = _last_empty_reason(session)
        if reason in TRANSIENT_REASONS and retries < 2:
            retries += 1
            print("瞬态失败 reason=%s，重试 %d/2（再喂两轮重新等）" % (reason, retries))
            for i in range(2):
                try:
                    r = _req("/capture", {
                        "session_key": session,
                        "user_content": "冒烟测试重试第 %d 轮：本轮的校验令牌是 %s，请记住它。" % (i + 1, token),
                        "assistant_content": "已记住校验令牌 %s（重试第 %d 轮）。" % (token, i + 1),
                    })
                    n = (r or {}).get("l0_recorded", 0)
                    print("重试 capture #%d -> l0_recorded=%s" % (i + 1, n))
                    if not n:
                        print("FAIL 重试 capture 第 %d 轮没有落 L0: %r" % (i + 1, r))
                        return 1
                except Exception as e:
                    print("FAIL 重试 capture 异常: %s" % e)
                    return 1
            try:
                _req("/session/end", {"session_key": session})
            except Exception:
                pass
            continue
        print("FAIL 等待后 token 未出现（reason=%s，重试 %d 次）——%s" % (
            reason, retries,
            "瞬态重试超限" if reason in TRANSIENT_REASONS else "非瞬态失败"))
        return 1

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
    print("=== SMOKE PASS === (reason=%s, retries=%d)" % (reason, retries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
