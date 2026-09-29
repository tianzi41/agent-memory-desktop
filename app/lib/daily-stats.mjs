// daily-stats.mjs — 今日统计：L0 新增条数 + 提炼任务完成/失败数（跨天自动清零）
// 累加器规则：单调计数器取差量；遇计数器重置（内核重启归零）按"从 0 重新爬的部分"续算
// 落盘 data/config/daily-stats.json：关页面/重启 Web/重启内核均不丢，跨天才清零
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { configDir, writeFileAtomic } from "./config-gen.mjs";

const FILE = path.join(configDir(), "daily-stats.json");

// 本地日期字符串（按用户时区跨天，不用 UTC）
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function load() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return null; }
}

function save(s) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileAtomic(FILE, JSON.stringify(s, null, 2));
  } catch { /* 落盘失败不阻塞内存统计 */ }
}

const view = (s) => ({ date: s.date, l0Added: s.l0Added, tasksDone: s.tasksDone, tasksFailed: s.tasksFailed });

// 采样一次并更新累加器；sample 中字段 undefined 表示对应数据源不可用，该项不更新
export function updateDaily(sample = {}) {
  const t = todayStr();
  const l0 = num(sample.l0Total), done = num(sample.tasksDone), failed = num(sample.tasksFailed);
  let s = load();

  if (!s) {
    // 首次运行：只建基线不计数（历史存量不是"今天新增"）
    s = { date: t, l0Added: 0, tasksDone: 0, tasksFailed: 0, last: { l0: l0 ?? 0, done: done ?? 0, failed: failed ?? 0 } };
    save(s);
    return view(s);
  }

  if (s.date !== t) {
    // 新的一天：清零累加器，以本次采样为基线（基线之前的活动不属于今天）
    s = { date: t, l0Added: 0, tasksDone: 0, tasksFailed: 0, last: { l0: l0 ?? 0, done: done ?? 0, failed: failed ?? 0 } };
    save(s);
    return view(s);
  }

  if (l0 !== undefined) {
    if (l0 >= s.last.l0) s.l0Added += l0 - s.last.l0; // L0 只增不减（无删除通道）；异常回落不倒扣
    s.last.l0 = l0;
  }
  if (done !== undefined) {
    s.tasksDone += done >= s.last.done ? done - s.last.done : done; // 计数器归零（内核重启）→ 从 0 爬的部分计入今天
    s.last.done = done;
  }
  if (failed !== undefined) {
    s.tasksFailed += failed >= s.last.failed ? failed - s.last.failed : failed;
    s.last.failed = failed;
  }
  save(s);
  return view(s);
}

// 展示用：跨天未采样时按今日零值展示（下次采样自动落盘重置）
export function getDaily() {
  const s = load();
  if (!s || s.date !== todayStr()) return { date: todayStr(), l0Added: 0, tasksDone: 0, tasksFailed: 0 };
  return view(s);
}
