#!/usr/bin/env node
/**
 * backup-memory.cjs — 记忆库全量备份（dated + manifest + sha256 + 轮转）
 *
 * 用法:
 *   node scripts/backup-memory.cjs                    # 默认备份 Q:/agent-memory-data
 *   node scripts/backup-memory.cjs --keep 5           # 保留最近 5 份
 *   node scripts/backup-memory.cjs --no-restart       # 不自动停/启内核（内核没在跑时用）
 *   node scripts/backup-memory.cjs --include-config   # 连带备份桌面端 data/config
 *
 * 做什么:
 *   1. 停内核（经 /api/kernel/stop，看门狗不会插手）→ 等端口释放
 *   2. 整目录拷贝（跳过历史备份目录本身，不递归备份备份）
 *   3. 生成 manifest.json：每个文件的字节数 + sha256
 *   4. 校验：对拷贝结果逐文件重算 sha256 与 manifest 比对
 *   5. 重启内核 → 轮转（保留最近 --keep 份，默认 3）
 *
 * 为什么停内核再拷: vectors.db-wal 常有未 checkpoint 的数据，
 * 运行中直接拷文件得到的是撕裂快照。
 *
 * 退出码: 0 = 成功; 1 = 失败（失败时会尽力重启内核）
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes("--" + name);

// path.resolve 规范化：直接剥尾斜杠会把 "Q:/" 变成 "Q:"——那是"每驱动器当前目录"
// (本进程里并非 Q:\ 根)，轮转会去错误的位置列举/删除。
const DATA_DIR = path.resolve(arg("data-dir", "Q:/agent-memory-data"));
const OUT_ROOT = path.resolve(arg("out-root", "Q:/"));
const KEEP = Math.max(1, parseInt(arg("keep", "3"), 10) || 3);
const NO_RESTART = flag("no-restart");
const INCLUDE_CONFIG = flag("include-config");
const DESKTOP_CONFIG = "Q:/agent-memory-desktop/data/config";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEB = "http://127.0.0.1:8430";
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  // 精确到秒：分钟粒度下同一分钟重跑会撞名——cpSync 会往已存在的备份里合并
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 目标目录已存在时改名而不是合并：合并会把两份备份搅在一起，manifest 也对不上
function uniqueDest(root, base) {
  let dest = path.join(root, base);
  let n = 2;
  while (fs.existsSync(dest)) { dest = path.join(root, base + "-" + n); n++; }
  return dest;
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function walk(dir, base, out, skipRe) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      if (skipRe && skipRe.test(e.name)) continue;
      walk(full, base, out, skipRe);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

(async () => {
  if (!fs.existsSync(DATA_DIR)) { console.error("数据目录不存在: " + DATA_DIR); process.exit(1); }
  const dest = uniqueDest(OUT_ROOT, `memory-backup-${stamp()}`);
  console.log("==> 备份 " + DATA_DIR + " -> " + dest);

  // 1) 停内核（Web 可达才停；不可达说明没在跑，无需停也不必重启）
  let kernelWasRunning = false;
  if (!NO_RESTART) {
    try {
      const r = await fetch(WEB + "/api/kernel/stop", { method: "POST", signal: AbortSignal.timeout(10000) });
      kernelWasRunning = (await r.json()).stopped === true;
      if (kernelWasRunning) {
        for (let i = 0; i < 15; i++) {
          await sleep(1000);
          const { execSync } = require("node:child_process");
          const listening = execSync("netstat -ano", { encoding: "utf8" }).includes(":8420 ") &&
            execSync("netstat -ano", { encoding: "utf8" }).split(/\r?\n/).some((l) => /:8420\s+.*LISTENING/i.test(l));
          if (!listening) { console.log("    内核已停（端口释放 " + (i + 1) + "s）"); break; }
        }
      }
    } catch { console.log("    Web 服务不可达，按内核未运行处理"); }
  }

  // 保险丝：任何导致进程退出的路径（未预料的异常/abort）都要把内核拉回来——
  // /api/kernel/stop 会置"用户已停"，web 看门狗不会救，只能自己救
  process.on("exit", (code) => {
    if (kernelWasRunning && !restarted && !NO_RESTART && code !== 0) {
      try {
        require("node:child_process").spawn(
          process.execPath,
          ["-e", `fetch("${WEB}/api/kernel/start",{method:"POST"});`],
          { detached: true, stdio: "ignore" },
        ).unref();
      } catch { /* 最后的努力也失败就只能人工启动 */ }
    }
  });

  let restarted = false;
  const restart = async () => {
    if (restarted || !kernelWasRunning || NO_RESTART) return;
    restarted = true;
    try {
      const r = await fetch(WEB + "/api/kernel/start", { method: "POST", signal: AbortSignal.timeout(90000) });
      const j = await r.json();
      console.log("    内核已重启 healthy=" + j.healthy);
    } catch (e) { console.error("    ⚠️ 内核重启失败，请手动启动: " + e.message); }
  };

  try {
    // 2) 拷贝（跳过历史备份目录，避免递归备份备份）
    const skipRe = /^(memory-backup-|backup-pre-clean-|manual-backup-)/;
    fs.cpSync(DATA_DIR, dest, {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src);
        if (src === DATA_DIR) return true;
        if (fs.statSync(src).isDirectory() && skipRe.test(name)) return false;
        return true;
      },
    });
    if (INCLUDE_CONFIG && fs.existsSync(DESKTOP_CONFIG)) {
      fs.cpSync(DESKTOP_CONFIG, path.join(dest, "desktop-data-config"), { recursive: true });
      console.log("    已附带桌面端 data/config");
    }

    // 3) manifest：逐文件 sha256
    const files = [];
    walk(dest, dest, files, null);
    const entries = [];
    let total = 0;
    for (const rel of files.sort()) {
      const st = fs.statSync(path.join(dest, rel));
      total += st.size;
      entries.push({ path: rel.replace(/\\/g, "/"), bytes: st.size, sha256: sha256(path.join(dest, rel)) });
    }
    const manifest = {
      tool: "backup-memory.cjs",
      createdAt: new Date().toISOString(),
      source: DATA_DIR,
      includeDesktopConfig: INCLUDE_CONFIG,
      fileCount: entries.length,
      totalBytes: total,
      files: entries,
    };
    fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    console.log(`    已拷贝 ${entries.length} 个文件（${(total / 1024 / 1024).toFixed(1)} MB）并生成 manifest`);

    // 4) 校验：重算比对
    let bad = 0;
    for (const e of entries) {
      const p = path.join(dest, e.path);
      if (!fs.existsSync(p)) { bad++; console.error("    ❌ 缺失: " + e.path); continue; }
      if (sha256(p) !== e.sha256) { bad++; console.error("    ❌ 校验失败: " + e.path); }
    }
    if (bad) { console.error(`校验失败 ${bad} 个文件，备份不可信`); await restart(); process.exit(1); }
    console.log("    sha256 校验全部通过");

    // 5) 轮转
    const prefix = "memory-backup-";
    const olds = fs.readdirSync(OUT_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name).sort();
    const excess = olds.slice(0, Math.max(0, olds.length - KEEP));
    for (const name of excess) {
      fs.rmSync(path.join(OUT_ROOT, name), { recursive: true, force: true });
      console.log("    轮转删除: " + name);
    }
    console.log(`    当前保留 ${Math.min(olds.length, KEEP)} 份备份（--keep ${KEEP}）`);

    await restart();
    console.log("✅ 备份完成: " + dest);
    process.exit(0);
  } catch (e) {
    console.error("备份失败: " + e.message);
    await restart();
    process.exit(1);
  }
})();
