import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./http.js";
import { testServerUrl } from "./test-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function startApp(connectionString: string) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  const app = buildApp({ pool });
  cleanups.push(() => app.close(), () => pool.end());
  return app;
}

describe("健康检查", () => {
  it("数据库连得上时报健康", async () => {
    const app = startApp(testServerUrl);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  it("数据库连不上时报不健康，而不是无脑返回 200", async () => {
    // 一个没人监听的端口。连不上库还报健康的服务比没有健康检查更糟——
    // compose 会以为它起好了，后面的票全在一个坏掉的地基上跑。
    const app = startApp("postgres://ureview:ureview@127.0.0.1:1/ureview");

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "error", database: "error" });
  });
});
