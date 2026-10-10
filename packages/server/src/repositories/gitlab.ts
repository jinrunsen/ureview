import { authenticatedGitUrl, getResponse, parseJson, PlatformTransportError, runReadOnlyGit, withGitCredentials } from "../platform/transport.js";
import {
  RepositoryAccessError,
  type RepositoryAccessInput,
  type RepositoryConnector,
  type VerifiedRepository,
} from "./connector.js";

const accessDenied = "令牌无法读取该仓库，请确认令牌范围包含此仓库的只读权限";
const unavailable = "暂时无法连接 GitLab，请检查实例地址和网络后重试";
const invalidResponse = "GitLab 返回的数据无法验证仓库，请检查实例配置后重试";
const invalidInput = "请填写有效的 GitLab 实例地址、项目路径和个人访问令牌";
const maxResponseBytes = 1024 * 1024;

function parseUrl(value: string, code: "invalid_input" | "invalid_response"): URL {
  const fail = () => new RepositoryAccessError(code, code === "invalid_input" ? invalidInput : invalidResponse);
  if (/[\s\\]/.test(value)) throw fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  // 内网 GitLab 可能只开 http，令牌明文传输由部署方自行承担。
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash
  ) throw fail();
  return url;
}

function normalizeInput(input: RepositoryAccessInput): RepositoryAccessInput {
  const instance = parseUrl(input.instanceUrl.trim(), "invalid_input");
  let projectPath: string;
  try {
    projectPath = decodeURIComponent(input.projectPath.trim());
  } catch {
    throw new RepositoryAccessError("invalid_input", invalidInput);
  }
  const segments = projectPath.split("/");
  const projectId = /^[1-9]\d*$/.test(projectPath);
  const namedProject = segments.length >= 2 && segments.every(
    (segment) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(segment),
  );
  if (
    (!projectId && !namedProject) || projectPath.length > 2048 ||
    !/^[\x21-\x7e]{1,4096}$/.test(input.token)
  ) throw new RepositoryAccessError("invalid_input", invalidInput);
  return {
    instanceUrl: instance.href.replace(/\/+$/, ""),
    projectPath,
    token: input.token,
  };
}

function projectUrl(value: unknown, instanceUrl: string): string {
  if (typeof value !== "string") throw new RepositoryAccessError("invalid_response", invalidResponse);
  const url = parseUrl(value, "invalid_response");
  const instance = new URL(instanceUrl);
  const prefix = instance.pathname.replace(/\/+$/, "") + "/";
  if (url.origin !== instance.origin || !url.pathname.startsWith(prefix)) {
    throw new RepositoryAccessError("invalid_response", invalidResponse);
  }
  return url.href;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepositoryAccessError("invalid_response", invalidResponse);
  }
  return value as Record<string, unknown>;
}

export class GitLabConnector implements RepositoryConnector {
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("GitLab 连接超时必须是正整数毫秒");
    }
  }

  async verify(input: RepositoryAccessInput): Promise<VerifiedRepository> {
    const normalized = normalizeInput(input);
    const { instanceUrl, projectPath, token } = normalized;
    // GitLab 15.5 之前没有令牌自省接口，此时跳过范围检查，靠读取项目和 git 来验证权限。
    const credential = await this.getTokenSelf(instanceUrl, token);
    if (credential) {
      if (credential.active !== true || credential.revoked !== false) {
        throw new RepositoryAccessError("access_denied", accessDenied);
      }
      const scopes = credential.scopes;
      // 老版本 GitLab 没有 read_api，读 MR 接口只能用 api 范围。
      if (!Array.isArray(scopes) ||
        !(scopes.includes("api") || (scopes.includes("read_api") && scopes.includes("read_repository")))) {
        throw new RepositoryAccessError("invalid_scope", "请使用包含 read_api 和 read_repository（或 api）权限的个人访问令牌");
      }
    }
    const project = object(await this.getJson(`${instanceUrl}/api/v4/projects/${encodeURIComponent(projectPath)}`, token));
    if (
      typeof project.id !== "number" || !Number.isSafeInteger(project.id) || project.id < 1 ||
      typeof project.name !== "string" || !project.name.trim() ||
      typeof project.path_with_namespace !== "string" || !project.path_with_namespace.trim()
    ) throw new RepositoryAccessError("invalid_response", invalidResponse);

    const verified: VerifiedRepository = {
      instanceUrl,
      projectId: project.id,
      name: project.name,
      pathWithNamespace: project.path_with_namespace,
      webUrl: projectUrl(project.web_url, instanceUrl),
      httpUrlToRepo: projectUrl(project.http_url_to_repo, instanceUrl),
    };
    await this.verifyGitRead(verified.httpUrlToRepo, token);
    return verified;
  }

  private async getTokenSelf(instanceUrl: string, token: string): Promise<Record<string, unknown> | null> {
    try {
      const { body } = await getResponse(`${instanceUrl}/api/v4/personal_access_tokens/self`, token, this.timeoutMs, maxResponseBytes);
      return object(parseJson(body));
    } catch (error) {
      if (error instanceof PlatformTransportError && error.httpStatus === 404) return null;
      throw error instanceof RepositoryAccessError ? error : this.accessError(error);
    }
  }

  private async getJson(url: string, token: string): Promise<unknown> {
    try {
      const { body } = await getResponse(url, token, this.timeoutMs, maxResponseBytes);
      return parseJson(body);
    } catch (error) {
      throw this.accessError(error);
    }
  }

  private async verifyGitRead(url: string, token: string): Promise<void> {
    try {
      await withGitCredentials(token, async (credentials) => {
        await runReadOnlyGit("ls-remote", ["--quiet", authenticatedGitUrl(url), "HEAD"],
          credentials.directory, credentials, this.timeoutMs);
      });
    } catch (error) {
      throw this.accessError(error);
    }
  }

  private accessError(error: unknown): RepositoryAccessError {
    if (error instanceof PlatformTransportError) {
      if (error.code === "access_denied") return new RepositoryAccessError("access_denied", accessDenied);
      if (["invalid_response", "response_too_large"].includes(error.code)) {
        return new RepositoryAccessError("invalid_response", invalidResponse);
      }
    }
    return new RepositoryAccessError("unavailable", unavailable);
  }
}
