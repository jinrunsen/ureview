import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("凭据密钥必须是 32 字节");
    this.key = Buffer.from(key);
  }

  encrypt(token: string, context: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
  }

  decrypt(payload: Buffer, context: string): string {
    try {
      if (payload.length < 29 || payload[0] !== 1) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(1, 13));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(payload.subarray(13, 29));
      return Buffer.concat([cipher.update(payload.subarray(29)), cipher.final()]).toString("utf8");
    } catch {
      throw new Error("仓库凭据无法解密，请检查凭据密钥文件");
    }
  }
}

/** 密钥单独保存在持久卷；有凭据时不自动补造丢失的密钥。 */
export async function loadCredentialCipher(keyFile: string, hasCredentials: boolean): Promise<CredentialCipher> {
  try {
    return new CredentialCipher(await readFile(keyFile));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (hasCredentials) throw new Error("凭据密钥文件丢失，请恢复原密钥后启动");
  }

  await mkdir(dirname(keyFile), { recursive: true });
  const temporary = join(dirname(keyFile), `.credential-key-${randomUUID()}`);
  try {
    await writeFile(temporary, randomBytes(32), { mode: 0o600, flag: "wx" });
    try {
      // 硬链接原子发布完整密钥，并发启动者复用先发布的那份。
      await link(temporary, keyFile);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return new CredentialCipher(await readFile(keyFile));
  } finally {
    await rm(temporary, { force: true });
  }
}
