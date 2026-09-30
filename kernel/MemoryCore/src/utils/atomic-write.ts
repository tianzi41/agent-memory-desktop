/**
 * 原子写：同目录先写临时文件再 rename。
 *
 * 直接 writeFile 是 truncate-then-write——崩溃/断电/第二个写者会留下撕 half 的文件：
 * scene_index.json 撕一半会被读成"零场景"（persona/recall 基于假前提继续），
 * scene .md 撕一半直接丢内容（审计 K-HIGH-05）。
 * 参考实现：checkpoint.ts 的 writeRaw。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}
