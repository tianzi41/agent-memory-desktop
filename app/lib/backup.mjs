// backup.mjs — 记忆库备份/导出与恢复（零依赖：系统自带 tar.exe 打包 zip）
// 导出：停内核 -> tar 打包数据目录（含 db/shm/wal 三个文件，保证一致性）-> 重启内核 -> 返回 zip 路径
// 导入：停内核 -> 当前数据目录滚动备份 -> 清空解压 -> 重启内核
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadAppConfig, stopKernel, startKernel, kernelRunning, beginKernelMaintenance, endKernelMaintenance } from "./kernel.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BACKUP_DIR = path.join(ROOT, "backup");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// 短随机后缀（#45）：stamp 只到秒，同秒连续两次导出/滚存会互相覆盖
function uniq() {
  return "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// tar 超时按体积估算（#45）：保守 5MB/s；下限 120s、上限 30min。
// 旧版固定 300s，库大了必在打包中途被 execFileSync 掐断（表现为"打包失败"）
export function estimateTarTimeout(srcDir) {
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try { if (e.isDirectory()) walk(p); else bytes += statSync(p).size || 0; } catch { /* 跳过无权限项 */ }
    }
  };
  walk(srcDir);
  return Math.min(1800_000, Math.max(120_000, Math.ceil(bytes / (5 * 1024 * 1024)) * 1000));
}

// 等端口释放（#45，修法同 backup-memory.cjs 停核语义）：停核后轮询而非固定 sleep
async function waitPortFree(port, maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const out = execFileSync("netstat", ["-ano"], { windowsHide: true }).toString("utf8");
    if (!out.split(/\r?\n/).some((l) => l.includes(":" + port + " ") && /LISTENING/i.test(l))) return true;
    await sleep(500);
  }
  return false;
}

// 导出后校验（#30）：tar -tvf 清单 vs 源目录，文件数+总大小必须一致。
// 任一行解析不了直接抛——宁可误报失败，不可静默放过不一致的"备份"
export function verifyArchive(zipFile, srcDir) {
  const lines = execFileSync("tar", ["-tvf", zipFile], { windowsHide: true, timeout: 120000 }).toString("utf8").split(/\r?\n/).filter((l) => l.trim());
  let zipCount = 0, zipBytes = 0;
  for (const line of lines) {
    // bsdtar tvf 列式：权限 nlink owner group size 日期 时间 路径
    const m = line.match(/^(\S)\S*\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.*)$/);
    if (!m) throw new Error("tar 清单行无法解析: " + line.slice(0, 100));
    if (m[1] === "d") continue; // 目录条目不计文件数
    zipCount++;
    zipBytes += Number(m[2]);
  }
  let srcCount = 0, srcBytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      try { if (e.isDirectory()) walk(p); else { srcCount++; srcBytes += statSync(p).size || 0; } } catch { /* 跳过 */ }
    }
  };
  walk(srcDir);
  if (zipCount !== srcCount || zipBytes !== srcBytes) {
    throw new Error(`源/包不一致：文件数 ${srcCount}→${zipCount}，总大小 ${srcBytes}→${zipBytes}`);
  }
  return { files: srcCount, bytes: srcBytes };
}

// 数据目录（记忆库根）：app.json 的 dataDir，缺省包内 data/memory-tdai
function dataDir() {
  const cfg = loadAppConfig();
  return (cfg?.dataDir || path.join(ROOT, "data", "memory-tdai")).replaceAll("\\", "/");
}

function tarPack(srcDir, outFile) {
  const parent = path.dirname(srcDir);
  const base = path.basename(srcDir);
  mkdirSync(path.dirname(outFile), { recursive: true });
  // -a 按扩展名选格式（.zip）；-C 切到父目录只打 base 这一层（解压后层级正确）
  execFileSync("tar", ["-a", "-c", "-f", outFile, "-C", parent, base], { windowsHide: true, timeout: estimateTarTimeout(srcDir) });
}

function tarUnpack(zipFile, destParent) {
  execFileSync("tar", ["-x", "-f", zipFile, "-C", destParent], { windowsHide: true, timeout: 300000 });
}

// 导出记忆库：返回 { ok, name } —— name 用于 /backup/<name> 下载
export async function exportBackup() {
  if (!existsSync(dataDir())) return { ok: false, error: "数据目录不存在：" + dataDir() };
  if (!kernelRunning()) {
    return { ok: false, error: "内核不是由本程序启动的（外部进程），无法安全停机打包。请先通过 stop.bat 停止内核后再导出。" };
  }
  const name = `amd-memory-${stamp()}${uniq()}.zip`;
  const out = path.join(BACKUP_DIR, name);
  beginKernelMaintenance(); // 停核打包期间看护不许拉活（备份一致性，#15）
  try {
    try {
      await stopKernel();
      // 等端口释放（#45）：固定 sleep 2.5s 在内核退出慢时会在库还在写时开打
      if (!(await waitPortFree(8420))) throw new Error("内核停止超时（端口 15s 未释放），放弃打包");
      tarPack(dataDir(), out);
      // 源/包一致性校验（#30）：文件数+总大小对不上，这份备份不可信
      verifyArchive(out, dataDir());
    } catch (e) {
      await startKernel().catch(() => {}); // 打包失败也要把内核拉回来
      return { ok: false, error: "打包失败：" + String(e.message || e) };
    }
    const k = await startKernel();
    return { ok: true, name, sizeKB: Math.round(statSync(out).size / 1024), kernelRestarted: k.healthy };
  } finally {
    endKernelMaintenance();
  }
}

function tarList(zipFile) {
  return execFileSync("tar", ["-tf", zipFile], { windowsHide: true, timeout: 60000 }).toString("utf8").split(/\r?\n/).filter(Boolean);
}

// 归档准入校验（#1）：唯一顶层目录必须 == basename(dataDir)，且无绝对路径/.. 成员。
// 在停内核之前跑——传错包时连内核都不惊动、数据原样不动
function validateArchive(zipFile, dir) {
  const entries = tarList(zipFile);
  if (!entries.length) throw new Error("压缩包内容为空");
  const tops = new Set();
  for (const e of entries) {
    const parts = e.replace(/\\/g, "/").split("/");
    if (/^[A-Za-z]:/.test(e) || parts.includes("..")) throw new Error("压缩包含非法路径条目：" + e);
    if (parts[0]) tops.add(parts[0]);
  }
  const expect = path.basename(dir);
  if (tops.size !== 1 || !tops.has(expect)) {
    throw new Error(`压缩包顶层目录应为「${expect}」，实际是「${[...tops].join("、") || "（空）"}」，已拒绝（记忆库未被改动）`);
  }
}

// 导入恢复：zipBuffer 为用户上传的 zip 内容。恢复前自动滚动备份当前数据目录
export async function importBackup(zipBuffer) {
  if (!zipBuffer || zipBuffer.length < 1024) return { ok: false, error: "文件为空或不是有效的备份（过小）" };
  if (!kernelRunning()) {
    return { ok: false, error: "内核不是由本程序启动的（外部进程），无法安全停机恢复。请先通过 stop.bat 停止内核后再恢复。" };
  }
  const dir = dataDir();
  const parent = path.dirname(dir);
  const tmpZip = path.join(BACKUP_DIR, `restore-upload-${stamp()}${uniq()}.zip`);
  let rollback = null;
  beginKernelMaintenance(); // 停核恢复期间看护不许拉活（#15）
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(tmpZip, zipBuffer);
    validateArchive(tmpZip, dir); // 先验包：不合规直接返回，不停内核不动数据
    await stopKernel();
    // 等端口释放（#45）：没停稳就 rmSync+解压 = 热删写库
    if (!(await waitPortFree(8420))) throw new Error("内核停止超时（端口 15s 未释放），放弃恢复");
    // 滚动备份当前数据目录（恢复操作的后悔药）
    if (existsSync(dir)) {
      rollback = path.join(BACKUP_DIR, `rollback-${stamp()}${uniq()}.zip`);
      tarPack(dir, rollback);
      rmSync(dir, { recursive: true, force: true });
    }
    tarUnpack(tmpZip, parent);
    // 解压后校验：目录必须在且非空，否则按失败走回滚
    if (!existsSync(dir) || readdirSync(dir).length === 0) throw new Error("解压结果为空或目录缺失");
    const k = await startKernel();
    return { ok: true, rollback: rollback ? path.basename(rollback) : null, kernelRestarted: k.healthy };
  } catch (e) {
    // 恢复失败：无条件重放滚动备份（旧版 !existsSync(dir) 条件会在半解压后跳过回滚，留下混合数据）
    try {
      if (rollback && existsSync(rollback)) {
        rmSync(dir, { recursive: true, force: true });
        tarUnpack(rollback, parent);
      }
    } catch { /* 兜底失败只能靠 backup 目录里的 rollback 包手动处理 */ }
    await startKernel().catch(() => {});
    return { ok: false, error: "恢复失败（已尝试回滚）：" + String(e.message || e) };
  } finally {
    endKernelMaintenance();
    try { rmSync(tmpZip, { force: true }); } catch { /* 临时包清理失败不致命 */ }
  }
}
