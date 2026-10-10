import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { fixtureInstanceUrl } from "../support/repository-fixtures.js";
import type { ApiWorld } from "../support/world.js";

function prepareCredential(world: ApiWorld, actor: string, repositoryName: string, readable: boolean) {
  world.actor = actor;
  world.repositoryName = repositoryName;
  world.accessToken = `fixture-${repositoryName}-${readable ? "read" : "denied"}`;
  world.connector.register(repositoryName, world.accessToken, readable);
}

Given(
  "管理员 {string} 拥有 GitLab 仓库 {string} 的只读访问令牌",
  function (this: ApiWorld, actor: string, repositoryName: string) {
    prepareCredential(this, actor, repositoryName, true);
  },
);

Given(
  "管理员 {string} 持有一个对仓库 {string} 没有读取权限的令牌",
  function (this: ApiWorld, actor: string, repositoryName: string) {
    prepareCredential(this, actor, repositoryName, false);
  },
);

When(
  "{string} 使用该令牌接入仓库 {string}",
  async function (this: ApiWorld, actor: string, repositoryName: string) {
    assert.equal(actor, this.actor);
    assert.equal(repositoryName, this.repositoryName);
    const response = await this.request("/api/repositories", {
      instanceUrl: fixtureInstanceUrl,
      projectPath: `commerce/${repositoryName}`,
      token: this.accessToken,
    });
    this.responseStatus = response.status;
    this.responseBody = response.body;
  },
);

Then("仓库列表中出现 {string}", async function (this: ApiWorld, repositoryName: string) {
  const response = await this.request("/api/repositories");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.repositories));
  const matches = response.body.repositories.filter((repository) => repository.name === repositoryName);
  assert.equal(matches.length, 1);
  this.listedRepository = matches[0];
});

Then("该仓库的连通状态为 {string}", function (this: ApiWorld, status: string) {
  assert.equal(status, "已连通");
  assert.equal(this.listedRepository?.connectionStatus, "connected");
});

Then("仓库 {string} 接入成功", function (this: ApiWorld, repositoryName: string) {
  assert.equal(this.responseStatus, 201);
  assert.equal(this.responseBody.repository?.name, repositoryName);
  assert.equal(this.responseBody.created, true);
});

Then("该仓库的权限说明为 {string}", function (this: ApiWorld, permissionNotice: string) {
  assert.equal(this.responseBody.permissionNotice, permissionNotice);
});

Then("接入失败", function (this: ApiWorld) {
  assert.equal(this.responseStatus, 422);
  assert.equal(this.responseBody.error?.code, "access_denied");
});

Then("系统提示 {string}", function (this: ApiWorld, message: string) {
  assert.equal(this.responseBody.error?.message, message);
});

Then("仓库列表中不出现 {string}", async function (this: ApiWorld, repositoryName: string) {
  const response = await this.request("/api/repositories");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.repositories));
  assert.equal(response.body.repositories.some((repository) => repository.name === repositoryName), false);
});
