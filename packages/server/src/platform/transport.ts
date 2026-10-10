import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class PlatformTransportError extends Error {
  constructor(readonly code: "access_denied" | "unavailable" | "invalid_response" | "response_too_large", readonly httpStatus?: number,
    readonly failure?: "timeout" | "network_error") {
    super("代码平台读取失败");
    this.name = "PlatformTransportError";
  }
}

export async function getResponse(
  url: string, token: string, timeoutMs: number, maxBytes: number,
): Promise<{ body: Buffer; headers: Headers }> {
  try {
    const response = await fetch(url, {
      method: "GET", headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformTransportError([401, 403, 404].includes(response.status) ? "access_denied" : "unavailable", response.status);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxBytes) throw new PlatformTransportError("response_too_large");
        chunks.push(chunk);
      }
    }
    return { body: Buffer.concat(chunks), headers: response.headers };
  } catch (error) {
    if (error instanceof PlatformTransportError) throw error;
    throw new PlatformTransportError("unavailable", undefined, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error");
  }
}

export function parseJson(body: Buffer): unknown {
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new PlatformTransportError("invalid_response"); }
}

interface GitCredentials { directory: string; askpass: string; token: string }

export async function withGitCredentials<T>(token: string, operation: (credentials: GitCredentials) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ureview-git-access-"));
  try {
    const askpass = join(directory, "askpass.sh");
    // 脚本没有凭据；令牌只传给这一组 Git 子进程。
    await writeFile(askpass, `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'oauth2' ;;
  *Password*) printf '%s\\n' "$UREVIEW_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    return await operation({ directory, askpass, token });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function authenticatedGitUrl(url: string): string {
  // 提前通过 ASKPASS 取密码，避免 libcurl 回退到宿主 .netrc。
  const authenticated = new URL(url);
  authenticated.username = "oauth2";
  return authenticated.href;
}

export async function runReadOnlyGit(
  command: "ls-remote" | "init" | "fetch" | "rev-parse" | "checkout",
  args: string[], cwd: string, credentials: GitCredentials, timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", [
      "-c", "credential.helper=", "-c", "http.followRedirects=false",
      "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.http.allow=always",
      "-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "submodule.recurse=false",
      command, ...args,
    ], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      // 白名单隔离宿主的凭据、URL 重写、代理和 Git 调试配置。
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_CONFIG_HOME: credentials.directory, LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CEILING_DIRECTORIES: credentials.directory, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: credentials.askpass,
        UREVIEW_GIT_TOKEN: credentials.token,
      },
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString("utf8").slice(0, 65_536 - stdout.length);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString("utf8").slice(0, 65_536 - stderr.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* 子进程可能已退出。 */ }
      }
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new PlatformTransportError("unavailable")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve(stdout.trim());
      reject(new PlatformTransportError(!timedOut && /Authentication failed|401|403|not found/i.test(stderr)
        ? "access_denied" : "unavailable"));
    });
  });
}
