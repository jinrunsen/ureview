import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryAccessError } from "./connector.js";
import { GitLabConnector } from "./gitlab.js";

const run = promisify(execFile);
const token = "glpat-protocol-fixture-secret";
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface FixtureOptions {
  prefix?: string;
  scopes?: string[];
  active?: boolean;
  revoked?: boolean;
  selfStatus?: number;
  projectStatus?: number;
  projectPatch?: Record<string, unknown>;
  clonePath?: string;
  redirect?: string;
  gitRedirect?: string;
  gitDenied?: boolean;
  empty?: boolean;
  hangApi?: boolean;
  hangGit?: boolean;
  malformed?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ureview-gitlab-fixture-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "group"));
  const remote = join(directory, "group/project.git");
  if (options.empty) {
    await run("git", ["init", "--bare", remote]);
  } else {
    const work = join(directory, "work");
    await run("git", ["init", "--initial-branch=main", work]);
    await run("git", ["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
    await run("git", ["clone", "--bare", work, remote]);
  }
  const prefix = options.prefix ?? "";
  const requests: Array<{ method: string; url: string; privateToken?: string; authorization?: string }> = [];
  let base: string;
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      ...(typeof request.headers["private-token"] === "string" ? { privateToken: request.headers["private-token"] } : {}),
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    });
    if (request.url?.startsWith(`${prefix}/api/v4/`)) {
      if (options.hangApi) return;
      if (options.redirect) {
        response.writeHead(302, { location: options.redirect }).end();
        return;
      }
      if (request.url.endsWith("/personal_access_tokens/self")) {
        if (request.headers["private-token"] !== token) {
          json(response, 401, { message: `无效令牌 ${token}` });
          return;
        }
        if (options.malformed) {
          response.writeHead(200).end(`invalid ${token}`);
          return;
        }
        json(response, options.selfStatus ?? 200, {
          active: options.active ?? true,
          revoked: options.revoked ?? false,
          scopes: options.scopes ?? ["read_repository", "read_api"],
          message: token,
        });
        return;
      }
      json(response, options.projectStatus ?? 200, {
        id: 42,
        name: "Project",
        path_with_namespace: "group/project",
        web_url: `${base}${prefix}/group/project`,
        http_url_to_repo: `${base}${options.clonePath ?? `${prefix}/group/project.git`}`,
        ...options.projectPatch,
        message: token,
      });
      return;
    }
    if (options.hangGit) return;
    if (options.gitRedirect) {
      response.writeHead(302, { location: options.gitRedirect }).end();
      return;
    }
    if (options.gitDenied) {
      response.writeHead(403).end(token);
      return;
    }
    if (request.headers.authorization !== `Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }).end();
      return;
    }
    serveGit(request, response, directory, prefix);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试监听地址无效");
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    directory,
    requests,
    input: { instanceUrl: `${base}${prefix}`, projectPath: "group/project", token },
  };
}

function serveGit(request: IncomingMessage, response: ServerResponse, directory: string, prefix: string) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const backend = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: directory,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname.slice(prefix.length),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      REMOTE_USER: "oauth2",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  backend.once("error", () => response.writeHead(500).end());
  backend.once("close", (code) => {
    if (code !== 0) {
      if (!response.headersSent) response.writeHead(500).end();
      return;
    }
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    const headers = output.subarray(0, split).toString("utf8").split("\r\n");
    for (const line of headers) {
      const separator = line.indexOf(":");
      const name = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === "status") response.statusCode = Number.parseInt(value, 10);
      else response.setHeader(name, value);
    }
    response.end(output.subarray(split + 4));
  });
  request.pipe(backend.stdin);
}

async function denied(promise: Promise<unknown>, code: RepositoryAccessError["code"]) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RepositoryAccessError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(token);
}

describe("GitLab 接入协议", () => {
  it("保留实例子路径和端口，读取项目规范字段，并用提交的令牌实际读取 Git", async () => {
    const gitlab = await fixture({ prefix: "/gitlab" });
    const result = await new GitLabConnector().verify({
      ...gitlab.input,
      instanceUrl: `${gitlab.input.instanceUrl}/`,
      projectPath: "group%2Fproject",
    });
    expect(result).toEqual({
      instanceUrl: `${gitlab.base}/gitlab`, projectId: 42, name: "Project", pathWithNamespace: "group/project",
      webUrl: `${gitlab.base}/gitlab/group/project`, httpUrlToRepo: `${gitlab.base}/gitlab/group/project.git`,
    });
    expect(gitlab.requests.slice(0, 2).map((request) => request.url)).toEqual([
      "/gitlab/api/v4/personal_access_tokens/self", "/gitlab/api/v4/projects/group%2Fproject",
    ]);
    expect(gitlab.requests.some((request) => request.authorization?.startsWith("Basic "))).toBe(true);
    expect(gitlab.requests.every((request) => request.method === "GET")).toBe(true);
    expect(gitlab.requests.every((request) => !request.url.includes(token))).toBe(true);
  });

  it("项目数字 ID 和没有 HEAD 的空仓库也可以接入", async () => {
    const gitlab = await fixture({ empty: true });
    await expect(new GitLabConnector().verify({ ...gitlab.input, projectPath: "42" })).resolves.toMatchObject({ projectId: 42 });
    expect(gitlab.requests[1]?.url).toBe("/api/v4/projects/42");
  });

  it.each([
    ["read_api"], ["read_repository"],
  ])("拒绝非指定只读权限组合 %j，尚未访问公开项目信息", async (...scopes) => {
    const gitlab = await fixture({ scopes });
    await denied(new GitLabConnector().verify(gitlab.input), "invalid_scope");
    expect(gitlab.requests).toHaveLength(1);
  });

  it.each([["api"], ["read_api", "read_repository", "write_repository"], ["read_api", "read_repository", "read_registry"]])("接受足够读取权限的令牌 %j，全部请求仍为只读", async (...scopes) => {
    const gitlab = await fixture({ scopes });
    await expect(new GitLabConnector().verify(gitlab.input)).resolves.toMatchObject({ projectId: 42 });
    expect(gitlab.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it.each([{ active: false }, { revoked: true }, { selfStatus: 401 }])("令牌失效时不会因项目公开而误报连通：%j", async (options) => {
    const gitlab = await fixture(options);
    await denied(new GitLabConnector().verify(gitlab.input), "access_denied");
    expect(gitlab.requests).toHaveLength(1);
  });

  it("公开项目可匿名读取时仍必须先验证提交的令牌", async () => {
    const gitlab = await fixture();
    await expect(fetch(`${gitlab.base}/api/v4/projects/42`).then((response) => response.status)).resolves.toBe(200);
    gitlab.requests.length = 0;
    await denied(new GitLabConnector().verify({ ...gitlab.input, token: "glpat-invalid" }), "access_denied");
    expect(gitlab.requests.map((request) => request.url)).toEqual(["/api/v4/personal_access_tokens/self"]);
  });

  it.each([401, 403, 404])("项目 API 返回 %i 时隐藏上游正文", async (projectStatus) => {
    const gitlab = await fixture({ projectStatus });
    await denied(new GitLabConnector().verify(gitlab.input), "access_denied");
    expect(gitlab.requests).toHaveLength(2);
  });

  it("项目 API 成功但 Git 无读取权限时仍拒绝接入", async () => {
    const gitlab = await fixture({ gitDenied: true });
    await denied(new GitLabConnector().verify(gitlab.input), "access_denied");
    expect(gitlab.requests.length).toBeGreaterThan(2);
  });

  it("无效 JSON 不会把上游正文或令牌带入错误", async () => {
    const gitlab = await fixture({ malformed: true });
    await denied(new GitLabConnector().verify(gitlab.input), "invalid_response");
  });

  it.each(["http://other.example/group/project.git", "https://example.com/group/project.git", "file:///tmp/project.git"])(
    "拒绝不安全或不同源的 clone 地址：%s", async (httpUrlToRepo) => {
      const gitlab = await fixture({ projectPatch: { http_url_to_repo: httpUrlToRepo } });
      await denied(new GitLabConnector().verify(gitlab.input), "invalid_response");
      expect(gitlab.requests).toHaveLength(2);
    },
  );

  it("API 和 Git 都不会跟随重定向泄露令牌", async () => {
    const receiver = await fixture();
    const apiRedirect = await fixture({ redirect: receiver.base });
    await denied(new GitLabConnector().verify(apiRedirect.input), "unavailable");
    const gitRedirect = await fixture({ gitRedirect: `${receiver.base}/group/project.git/info/refs?service=git-upload-pack` });
    await denied(new GitLabConnector().verify(gitRedirect.input), "unavailable");
    expect(receiver.requests).toHaveLength(0);
  });

  it("同一主机的其他端口和实例子路径之外都不能作为 clone 地址", async () => {
    const receiver = await fixture();
    const otherPort = await fixture({ projectPatch: { http_url_to_repo: `${receiver.base}/group/project.git` } });
    await denied(new GitLabConnector().verify(otherPort.input), "invalid_response");
    expect(receiver.requests).toHaveLength(0);
    const gitlab = await fixture({ prefix: "/gitlab", clonePath: "/group/project.git" });
    await denied(new GitLabConnector().verify(gitlab.input), "invalid_response");
    expect(gitlab.requests).toHaveLength(2);
  });

  it("不继承宿主 Git 的凭据、URL 重写或额外认证头", async () => {
    const receiver = await fixture();
    const gitlab = await fixture();
    const config = join(gitlab.directory, "host.gitconfig");
    await writeFile(config, `[url "${receiver.base}/"]\n  insteadOf = ${gitlab.base}/\n[credential]\n  helper = !printf 'username=wrong\\npassword=wrong\\n'\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraHeader");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "Authorization: Basic wrong");
    vi.stubEnv("GIT_ASKPASS", "/missing-host-askpass");
    await expect(new GitLabConnector().verify(gitlab.input)).resolves.toMatchObject({ projectId: 42 });
    expect(receiver.requests).toHaveLength(0);
    expect(gitlab.requests.every((request) => request.authorization !== "Basic wrong")).toBe(true);
  });

  it.each([{ hangApi: true }, { hangGit: true }])("API 或 Git 没有响应时在限时内返回：%j", async (options) => {
    const gitlab = await fixture(options);
    await denied(new GitLabConnector({ timeoutMs: 150 }).verify(gitlab.input), "unavailable");
  });

  it.each([
    { token: "glpat-secret\nInjected: value" }, { projectPath: "../project" },
    { projectPath: "https://gitlab.example.com/group/project" },
    { instanceUrl: "https://user:password@gitlab.example.com" },
    { instanceUrl: "https://gitlab.example.com?token=secret" },
    { instanceUrl: "https://gitlab.example.com#token" },
    { instanceUrl: "ftp://gitlab.example.com" },
  ])("无效输入在任何网络访问前被拒绝：%j", async (change) => {
    await denied(new GitLabConnector().verify({
      instanceUrl: "https://gitlab.example.invalid", projectPath: "group/project", token, ...change,
    }), "invalid_input");
  });
});
