import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialCipher, loadCredentialCipher } from "./credentials.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function keyPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ureview-credentials-"));
  directories.push(directory);
  return join(directory, "credentials.key");
}

describe("凭据加密", () => {
  it("密文绑定仓库，并拒绝错误密钥和篡改", () => {
    const cipher = new CredentialCipher(randomBytes(32));
    const token = "glpat-protocol-fixture";
    const encrypted = cipher.encrypt(token, "https://gitlab.example.com#24");
    expect(encrypted.includes(Buffer.from(token))).toBe(false);
    expect(cipher.decrypt(encrypted, "https://gitlab.example.com#24")).toBe(token);
    expect(() => cipher.decrypt(encrypted, "https://gitlab.example.com#25")).toThrow(/无法解密/);
    expect(() => new CredentialCipher(randomBytes(32)).decrypt(encrypted, "https://gitlab.example.com#24")).toThrow(/无法解密/);
    const tampered = Buffer.from(encrypted);
    tampered[29] = (tampered[29] ?? 0) ^ 1;
    expect(() => cipher.decrypt(tampered, "https://gitlab.example.com#24")).toThrow(/无法解密/);
  });

  it("并发首次启动和重启复用同一份权限受限的持久密钥", async () => {
    const path = await keyPath();
    const [first, concurrent] = await Promise.all([
      loadCredentialCipher(path, false), loadCredentialCipher(path, false),
    ]);
    const encrypted = first.encrypt("glpat-protocol-fixture", "repository");
    expect(concurrent.decrypt(encrypted, "repository")).toBe("glpat-protocol-fixture");
    const restarted = await loadCredentialCipher(path, true);
    expect(restarted.decrypt(encrypted, "repository")).toBe("glpat-protocol-fixture");
    expect((await readFile(path)).length).toBe(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("已有凭据时密钥丢失或损坏不会生成替代密钥", async () => {
    const path = await keyPath();
    await expect(loadCredentialCipher(path, true)).rejects.toThrow(/密钥文件丢失/);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "broken");
    await expect(loadCredentialCipher(path, false)).rejects.toThrow(/32 字节/);
    expect(await readFile(path, "utf8")).toBe("broken");
  });
});
