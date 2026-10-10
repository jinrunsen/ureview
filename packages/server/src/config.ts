import { join } from "node:path";

/** 服务运行需要的配置。缺一项就起不来，不留到运行时再崩。 */
export interface Config {
  /** PostgreSQL 连接串。单库承载一切，包括后面要用的队列。 */
  databaseUrl: string;
  /**
   * 代码工作副本的落盘目录。
   *
   * 必须挂在真实卷上，不能是容器内临时层：代码检索会 spawn 外部进程
   * 直接读盘，绕过运行时自己的文件系统抽象。
   */
  worktreeDir: string;
  /** 对象存储的落盘目录。起步用本地卷，将来换 S3 兼容存储时从这里替换。 */
  blobDir: string;
  /** 与数据库分开持久化的凭据密钥文件。 */
  credentialKeyFile: string;
  runtimeHome: string;
  webhookToken: string | undefined;
  publicOrigin: string;
  /** HTTP 监听端口。 */
  port: number;
  /** 同时执行的评审任务上限。 */
  reviewConcurrency: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_BLOB_DIR = "/srv/blobs";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`缺少必填配置 ${name}`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = required(env, "DATABASE_URL");
  const worktreeDir = required(env, "UREVIEW_WORKTREE_DIR");
  const blobDir = env["UREVIEW_BLOB_DIR"] ?? DEFAULT_BLOB_DIR;

  const rawPort = env["PORT"];
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== "") {
    // 写错的端口要当场报出来。悄悄退回默认值会让人以为服务没起来，
    // 实际上它在另一个端口上好好地跑着。
    port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`配置 PORT 不是一个合法端口：${rawPort}`);
    }
  }

  const credentialKeyFile = env["UREVIEW_CREDENTIAL_KEY_FILE"] ?? join(blobDir, "credentials.key");
  const runtimeHome = env["UREVIEW_RUNTIME_HOME"] ?? join(blobDir, "runtime");
  const webhookToken = env["UREVIEW_WEBHOOK_TOKEN"] || undefined;
  const publicOrigin = env["UREVIEW_PUBLIC_ORIGIN"] || `http://localhost:${port}`;
  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { throw new Error("UREVIEW_PUBLIC_ORIGIN 必须是服务的公开来源地址"); }
  if (!["http:","https:"].includes(origin.protocol) || origin.origin !== publicOrigin || origin.username || origin.password) {
    throw new Error("UREVIEW_PUBLIC_ORIGIN 必须是来源地址，不包含路径或凭据");
  }
  const rawConcurrency = env["UREVIEW_REVIEW_CONCURRENCY"];
  const reviewConcurrency = rawConcurrency === undefined || rawConcurrency === "" ? 5 : Number(rawConcurrency);
  if (!Number.isInteger(reviewConcurrency) || reviewConcurrency < 1 || reviewConcurrency > 20) {
    throw new Error(`配置 UREVIEW_REVIEW_CONCURRENCY 必须是 1 到 20 的整数：${rawConcurrency}`);
  }
  return { databaseUrl, worktreeDir, blobDir, credentialKeyFile, runtimeHome, webhookToken, publicOrigin, port, reviewConcurrency };
}
