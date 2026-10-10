import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { buildApp } from "../http.js";
import { testServerUrl } from "../test-support.js";
import {
  RepositoryAccessError,
  type RepositoryConnector,
  type VerifiedRepository,
} from "./connector.js";
import { CredentialCipher } from "./credentials.js";
import { RepositoryService } from "./service.js";

const fixtureRepository: VerifiedRepository = {
  instanceUrl: "https://gitlab.example.test",
  projectId: 482,
  name: "payment-gateway",
  pathWithNamespace: "commerce/payment-gateway",
  webUrl: "https://gitlab.example.test/commerce/payment-gateway",
  httpUrlToRepo: "https://gitlab.example.test/commerce/payment-gateway.git",
};

let databaseName: string;
let databaseCreated = false;
let pool: pg.Pool | undefined;
let app: FastifyInstance | undefined;
let baseUrl: string;
let cipher: CredentialCipher;
let verify: RepositoryConnector["verify"];
const connector: RepositoryConnector = { verify: (input) => verify(input) };

function database(): pg.Pool {
  if (!pool) throw new Error("测试数据库尚未启动");
  return pool;
}

async function startApp(): Promise<void> {
  const repositories = new RepositoryService(database(), connector, cipher);
  app = buildApp({ pool: database(), repositories });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}

beforeEach(async () => {
  databaseName = `ureview_repository_${randomUUID().replaceAll("-", "")}`;
  databaseCreated = false;
  pool = undefined;
  app = undefined;
  cipher = new CredentialCipher(randomBytes(32));
  verify = async () => fixtureRepository;
  const admin = new pg.Client({ connectionString: testServerUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
  } finally {
    await admin.end();
  }
  const databaseUrl = new URL(testServerUrl);
  databaseUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  await runMigrations(database(), fileURLToPath(new URL("../../migrations", import.meta.url)));
  await startApp();
});

afterEach(async () => {
  const errors: unknown[] = [];
  try {
    await app?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await pool?.end();
  } catch (error) {
    errors.push(error);
  }
  if (databaseCreated) {
    const admin = new pg.Client({ connectionString: testServerUrl });
    try {
      await admin.connect();
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    } catch (error) {
      errors.push(error);
    } finally {
      await admin.end().catch((error: unknown) => errors.push(error));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "清理仓库接入测试资源失败");
});

type Summary = Awaited<ReturnType<RepositoryService["list"]>>[number];

async function connect(token: string): Promise<{
  status: number;
  text: string;
  body: { repository: Summary; created: boolean; permissionNotice: string };
}> {
  const response = await fetch(`${baseUrl}/api/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceUrl: fixtureRepository.instanceUrl,
      projectPath: fixtureRepository.pathWithNamespace,
      token,
    }),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

describe("仓库接入的持久化与凭据边界", () => {
  it("并发接入同一仓库只建一条记录，重复接入保留首次凭据和接入时间", async () => {
    const tokens = Array.from({ length: 8 }, (_, index) => `fixture-read-token-${index}`);
    const responses = await Promise.all(tokens.map((token) => connect(token)));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    const createdIndex = responses.findIndex((response) => response.body.created);
    const created = responses[createdIndex];
    expect(created).toBeDefined();
    for (const response of responses) {
      expect(response.body.repository.id).toBe(created?.body.repository.id);
      expect(response.body.repository.connectedAt).toBe(created?.body.repository.connectedAt);
    }

    const repeated = await connect("fixture-replacement-token");
    expect(repeated.status).toBe(200);
    expect(repeated.body.created).toBe(false);
    expect(repeated.body.repository).toEqual(created?.body.repository);
    const { rows } = await database().query<{ credential_ciphertext: Buffer }>(
      "SELECT credential_ciphertext FROM repositories",
    );
    expect(rows).toHaveLength(1);
    expect(
      cipher.decrypt(rows[0]!.credential_ciphertext, `${fixtureRepository.instanceUrl}#482`),
    ).toBe(tokens[createdIndex]);
  });

  it("没有读取权限时返回明确提示且数据库与列表均没有仓库", async () => {
    verify = async () => {
      throw new RepositoryAccessError(
        "access_denied",
        "令牌无法读取该仓库，请确认令牌范围包含此仓库的只读权限",
      );
    };

    const response = await connect("fixture-denied-token");

    expect(response.status).toBe(422);
    expect(JSON.parse(response.text)).toEqual({
      error: {
        code: "access_denied",
        message: "令牌无法读取该仓库，请确认令牌范围包含此仓库的只读权限",
      },
    });
    const list = await fetch(`${baseUrl}/api/repositories`);
    expect(await list.json()).toMatchObject({ repositories: [] });
    expect((await database().query("SELECT id FROM repositories")).rows).toHaveLength(0);
  });

  it("只存储加密凭据，服务重新建立后可读取仓库且接口不返回凭据", async () => {
    const token = "fixture-secret-that-must-stay-out-of-responses";
    const response = await connect(token);
    expect(response.status).toBe(201);
    expect(response.text).not.toContain(token);
    expect(response.body.repository).not.toHaveProperty("credential_ciphertext");
    expect(response.body.repository).not.toHaveProperty("token");

    const { rows } = await database().query<{ credential_ciphertext: Buffer }>(
      "SELECT credential_ciphertext FROM repositories",
    );
    expect(rows).toHaveLength(1);
    const ciphertext = rows[0]!.credential_ciphertext;
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.includes(Buffer.from(token))).toBe(false);
    expect(cipher.decrypt(ciphertext, `${fixtureRepository.instanceUrl}#482`)).toBe(token);

    await app!.close();
    await startApp();
    const list = await fetch(`${baseUrl}/api/repositories`);
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain(token);
    expect(listText).not.toContain("credential_ciphertext");
    expect(JSON.parse(listText)).toMatchObject({ repositories: [response.body.repository] });
  });

  it("上游异常携带令牌时，HTTP 错误仍不泄露令牌且不落库", async () => {
    const token = "fixture-secret-from-upstream-error";
    verify = async () => {
      throw new Error(`上游失败：${token}`);
    };

    const response = await connect(token);

    expect(response.status).toBe(500);
    expect(response.text).not.toContain(token);
    expect(JSON.parse(response.text)).toHaveProperty("error.code");
    expect((await database().query("SELECT id FROM repositories")).rows).toHaveLength(0);
  });
});
