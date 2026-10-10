import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const completeEnv = {
  DATABASE_URL: "postgres://ureview:ureview@db:5432/ureview",
  UREVIEW_WORKTREE_DIR: "/srv/worktrees",
};

describe("配置加载", () => {
  it("遗留全局规范仓库变量不影响数据库规范配置", () => {
    expect(loadConfig({ ...completeEnv, UREVIEW_GLOBAL_RULES_REPOSITORY_ID: "retired-repository" })).toEqual(loadConfig(completeEnv));
  });

  it("缺少数据库连接串时，启动就失败并点名缺的是哪一个", () => {
    expect(() => loadConfig({ UREVIEW_WORKTREE_DIR: "/srv/worktrees" })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it("缺少代码工作副本目录时，启动就失败并点名缺的是哪一个", () => {
    expect(() => loadConfig({ DATABASE_URL: completeEnv.DATABASE_URL })).toThrowError(
      /UREVIEW_WORKTREE_DIR/,
    );
  });

  it("配置齐备时读出各项，端口没给就用默认值", () => {
    const config = loadConfig(completeEnv);
    expect(config.databaseUrl).toBe("postgres://ureview:ureview@db:5432/ureview");
    expect(config.worktreeDir).toBe("/srv/worktrees");
    expect(config.port).toBe(3000);
  });

  it("端口给了就用给的那个", () => {
    expect(loadConfig({ ...completeEnv, PORT: "8080" }).port).toBe(8080);
  });

  it("同时执行的评审任务默认 5 个，可配置为 1 到 20", () => {
    expect(loadConfig(completeEnv).reviewConcurrency).toBe(5);
    expect(loadConfig({ ...completeEnv, UREVIEW_REVIEW_CONCURRENCY: "2" }).reviewConcurrency).toBe(2);
    for (const value of ["0", "21", "3.5", "五"]) {
      expect(() => loadConfig({ ...completeEnv, UREVIEW_REVIEW_CONCURRENCY: value })).toThrowError(/UREVIEW_REVIEW_CONCURRENCY/);
    }
  });

  it("端口不是个数时，启动就失败而不是悄悄退回默认值", () => {
    expect(() => loadConfig({ ...completeEnv, PORT: "八千" })).toThrowError(/PORT/);
  });
});
