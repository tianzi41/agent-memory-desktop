/**
 * Scene Index: maintains a JSON index of all scene blocks for quick lookup.
 */

import { parseSceneBlock } from "./scene-format.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";

export interface SceneIndexEntry {
  filename: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
}

/**
 * 行视图后端的场景索引派生能力（P2-D2）：rowfs 模式下索引从 L2 行实时
 * 投影，`.metadata/scene_index.json` 不读不写。结构化鸭子类型，避免
 * scene ↔ storage 模块环依赖。
 */
interface SceneIndexDerivable {
  deriveSceneIndex(): Promise<SceneIndexEntry[]>;
}

function asSceneIndexDerivable(storage: StorageAdapter | undefined): SceneIndexDerivable | null {
  const backend = storage?.getBackend() as unknown as Partial<SceneIndexDerivable> | undefined;
  return backend && typeof backend.deriveSceneIndex === "function" ? backend as SceneIndexDerivable : null;
}

// ── fs fallback helpers (used when no StorageAdapter is provided) ──

import { writeFileAtomic } from "../../utils/atomic-write.js";

async function fsReadFile(absPath: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  try {
    return await fs.default.readFile(absPath, "utf-8");
  } catch { return null; }
}

async function fsWriteFile(absPath: string, content: string): Promise<void> {
  // 原子写：scene_index.json 被读成"零场景"比写慢一点糟糕得多（K-HIGH-05）
  await writeFileAtomic(absPath, content);
}

async function fsReaddir(absDir: string, suffix: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.default.readdir(absDir);
    return entries.filter((f) => f.endsWith(suffix));
  } catch { return []; }
}

/**
 * Read the scene index from disk.
 *
 * The index is written exclusively by syncSceneIndex() (engineering side).
 * The LLM is sandboxed to scene_blocks/ and cannot access this file.
 */
export async function readSceneIndex(dataDir: string, storage?: StorageAdapter): Promise<SceneIndexEntry[]> {
  // P2-D2: rowfs 模式索引实时派生自 L2 行，不读 sidecar 文件。
  const derivable = asSceneIndexDerivable(storage);
  if (derivable) return derivable.deriveSceneIndex();
  try {
    let raw: string | null;
    if (storage) {
      raw = await storage.readFile(StoragePaths.sceneIndex);
    } else {
      const path = await import("node:path");
      raw = await fsReadFile(path.default.join(dataDir, ".metadata", "scene_index.json"));
    }
    if (!raw) return [];

    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];

    const entries: SceneIndexEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;

      const filename = typeof item.filename === "string" ? item.filename : "";
      if (!filename) continue;

      entries.push({
        filename,
        summary: typeof item.summary === "string" ? item.summary : "",
        heat: typeof item.heat === "number" ? item.heat : 0,
        created: typeof item.created === "string" ? item.created : "",
        updated: typeof item.updated === "string" ? item.updated : "",
      });
    }
    return entries;
  } catch (e) {
    // 读不出索引不能静默返回 []：persona 生成/recall 会基于"零场景"的假前提继续，
    // 且无任何痕迹。先保证"坏了能知道"（彻底修法是 Result 类型，见审计 K-HIGH-06）。
    console.warn(`[scene-index] readSceneIndex failed, returning empty: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Write the scene index to disk.
 */
export async function writeSceneIndex(
  dataDir: string,
  entries: SceneIndexEntry[],
  storage?: StorageAdapter,
): Promise<void> {
  const content = JSON.stringify(entries, null, 2);
  if (storage) {
    await storage.writeFile(StoragePaths.sceneIndex, content);
  } else {
    const path = await import("node:path");
    await fsWriteFile(path.default.join(dataDir, ".metadata", "scene_index.json"), content);
  }
}

/**
 * Rebuild scene index by scanning all .md files in the scene_blocks directory.
 */
export async function syncSceneIndex(dataDir: string, storage?: StorageAdapter): Promise<SceneIndexEntry[]> {
  // P2-D2: rowfs 模式索引实时派生，不落盘（scene_index.json 退役）。
  const derivable = asSceneIndexDerivable(storage);
  if (derivable) return derivable.deriveSceneIndex();
  let files: string[];
  if (storage) {
    files = await storage.readdirNames(StoragePaths.sceneBlocksDir, ".md");
  } else {
    const path = await import("node:path");
    files = await fsReaddir(path.default.join(dataDir, "scene_blocks"), ".md");
  }

  // 并发解析：串行 await 每个 scene，maxScenes 提升后非线性变慢（K-HIGH-17）
  const parsed = await Promise.all(files.map(async (file) => {
    try {
      let raw: string | null;
      if (storage) {
        raw = await storage.readFile(`${StoragePaths.sceneBlocksDir}${file}`);
      } else {
        const path = await import("node:path");
        raw = await fsReadFile(path.default.join(dataDir, "scene_blocks", file));
      }
      if (!raw) return null;
      const block = parseSceneBlock(raw, file);
      return {
        filename: file,
        summary: block.meta.summary,
        heat: block.meta.heat,
        created: block.meta.created,
        updated: block.meta.updated,
      };
    } catch (e) {
      // 单个 scene 解析失败不拖垮整体同步，但留痕——否则"场景莫名少了"无迹可查
      console.warn(`[scene-index] syncSceneIndex skipped ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }));
  const entries = parsed.filter((e): e is SceneIndexEntry => e !== null);

  await writeSceneIndex(dataDir, entries, storage);
  return entries;
}
