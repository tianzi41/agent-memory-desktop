// backup.mjs — 记忆库备份/导出与恢复（零依赖：系统自带 tar.exe 打包 zip）
// 导出：停内核 -> tar 打包数据目录（含 db/shm/wal 三个文件，保证一致性）-> 重启内核 -> 返回 zip 路径
// 导入：停内核 -> 当前数据目录滚动备份 -> 清空解压 -> 重启内核
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadAppConfig, stopKernel, startKernel, kernelRunning } from "./kernel.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BACKUP_DIR = path.join(ROOT, "backup");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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
  execFileSync("tar", ["-a", "-c", "-f", outFile, "-C", parent, base], { windowsHide: true, timeout: 300000 });
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
  const name = `amd-memory-${stamp()}.zip`;
  const out = path.join(BACKUP_DIR, name);
  try {
    stopKernel();
    await sleep(2500); // 等进程退出、SQLite 落盘
    tarPack(dataDir(), out);
  } catch (e) {
    await startKernel().catch(() => {}); // 打包失败也要把内核拉回来
    return { ok: false, error: "打包失败：" + String(e.message || e) };
  }
  const k = await startKernel();
  return { ok: true, name, sizeKB: Math.round(statSync(out).size / 1024), kernelRestarted: k.healthy };
}

// 导入恢复：zipBuffer 为用户上传的 zip 内容。恢复前自动滚动备份当前数据目录
export async function importBackup(zipBuffer) {
  if (!zipBuffer || zipBuffer.length < 1024) return { ok: false, error: "文件为空或不是有效的备份（过小）" };
  if (!kernelRunning()) {
    return { ok: false, error: "内核不是由本程序启动的（外部进程），无法安全停机恢复。请先通过 stop.bat 停止内核后再恢复。" };
  }
  const dir = dataDir();
  const parent = path.dirname(dir);
  const tmpZip = path.join(BACKUP_DIR, `restore-upload-${stamp()}.zip`);
  let rollback = null;
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(tmpZip, zipBuffer);
    stopKernel();
    await sleep(2500);
    // 滚动备份当前数据目录（恢复操作的后悔药）
    if (existsSync(dir)) {
      rollback = path.join(BACKUP_DIR, `rollback-${stamp()}.zip`);
      tarPack(dir, rollback);
      rmSync(dir, { recursive: true, force: true });
    }
    tarUnpack(tmpZip, parent);
  } catch (e) {
    // 恢复失败：尝试把滚动备份放回去
    try {
      if (rollback && existsSync(rollback) && !existsSync(dir)) tarUnpack(rollback, parent);
    } catch { /* 兜底失败只能靠 backup 目录里的 rollback 包手动处理 */ }
    await startKernel().catch(() => {});
    return { ok: false, error: "恢复失败（已尝试回滚）：" + String(e.message || e) };
  }
  rmSync(tmpZip, { force: true });
  const k = await startKernel();
  return { ok: true, rollback: rollback ? path.basename(rollback) : null, kernelRestarted: k.healthy };
}
