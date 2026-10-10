import { posix } from "node:path";
import type { GitRuleFile } from "../reviews/types.js";
import { parseLintMetadata } from "./lint-metadata.js";
import { glob } from "./repository.js";

export interface CatalogLint {
  kind: "lint"; id: string; name: string; description: string; paths: string[];
  script: string; args: string[]; body: string; file: GitRuleFile; checkerRoot: string;
}

const MAX_BYTES = 1024 * 1024;
const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const depth = (root: string) => root ? root.split("/").length : 0;

export async function readLintCatalog(regular: Set<string>, readFile: (path: string) => Promise<string>,
  file: (path: string) => GitRuleFile, warnings: string[]): Promise<CatalogLint[]> {
  const entries = [...regular].flatMap((path) => {
    const match = /^(?:(.+)\/)?\.agents\/lints\/([^/]+\.mjs)$/.exec(path);
    return match ? [{ path, checkerRoot: match[1] ?? "" }] : [];
  }).sort((left, right) => depth(right.checkerRoot) - depth(left.checkerRoot) || lexical(left.path, right.path));
  const contents = new Map<string, string>();
  const read = async (path: string) => {
    let content = contents.get(path);
    if (content === undefined) { content = await readFile(path); contents.set(path, content); }
    return content;
  };
  const lints: CatalogLint[] = [];
  for (const { path, checkerRoot } of entries) {
    // 平台读取失败交给同步事务处理，保留上一份完整目录。
    const body = await read(path);
    let metadata: ReturnType<typeof parseLintMetadata>, paths: string[], script: string;
    try {
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("注册文件超过 1 MiB");
      metadata = parseLintMetadata(body);
      if (!metadata) throw new Error("缺少静态 meta 配置");
      paths = metadata.paths.filter((pattern) => {
        if (glob(pattern)) return true;
        warnings.push(`${path} 的无效 lint 路径条件已跳过`); return false;
      });
      if (!paths.length) throw new Error("没有有效路径条件");
      const target = metadata.script;
      if (target !== undefined && (!target.trim() || posix.isAbsolute(target) || /^[A-Za-z]:/.test(target) || /[\\\x00-\x1f\x7f]/.test(target))) {
        throw new Error("脚本路径必须是仓库内的相对路径");
      }
      script = target === undefined ? path : posix.normalize(posix.join(posix.dirname(path), target));
      if (script === ".." || script.startsWith("../") || !regular.has(script)) throw new Error("脚本必须是仓库内的普通文件");
    } catch (error) {
      warnings.push(`${path} 的 lint 配置无效，已跳过${error instanceof Error ? `：${error.message}` : ""}`);
      continue;
    }
    const scriptBody = await read(script);
    if (Buffer.byteLength(scriptBody) > MAX_BYTES) { warnings.push(`${path} 的 lint 脚本超过 1 MiB，已跳过`); continue; }
    lints.push({ kind: "lint", id: `lint:${path}`, name: metadata.name || posix.basename(path, ".mjs"),
      description: metadata.description ?? "", paths, script, args: metadata.args, body, file: file(path), checkerRoot });
  }
  return lints;
}
