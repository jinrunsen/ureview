import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError } from "./context.js";

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 6 || password.length > 32) throw new AuthError(400, "invalid_password", "密码需为 6 至 32 个字符");
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [, salt, encoded] = stored?.split(":") ?? [];
  const actual = await derive(password.slice(0, 128), salt ?? "00000000000000000000000000000000");
  const expected = encoded ? Buffer.from(encoded, "hex") : Buffer.alloc(64);
  return Boolean(stored?.startsWith("scrypt-v1:") && password.length <= 128 && expected.length === actual.length && timingSafeEqual(actual, expected));
}
