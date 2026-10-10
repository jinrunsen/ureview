import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { RuleImportScenario, importChecklist } from "../../packages/server/src/rules/import/test-support.js";
import { fixturePassword } from "../../packages/server/src/auth/test-support.js";
const execute = promisify(execFile);
interface BrowserState { scenario: RuleImportScenario; session: string; directory: string; file: string; seen: Set<string> }
const states = new WeakMap<ApiWorld, BrowserState>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
async function browser(value: BrowserState, ...args: string[]) { return (await execute("agent-browser", ["--session", value.session, ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
async function randomPort() {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return address.port;
}
Before({ tags: "@layer:e2e and @story:rule-library-import", timeout: 60000 }, async function (this: ApiWorld) {
  const directory = await mkdtemp(join(tmpdir(), "ureview-import-browser-"));
  const value: BrowserState = { scenario: new RuleImportScenario(), session: `ureview-import-${randomUUID()}`, directory, file: join(directory, "研发编程语言 checklist.md"), seen: new Set() };
  states.set(this, value); await writeFile(value.file, importChecklist());
  const port = await randomPort();
  await value.scenario.start({ port, publicOrigin: `http://127.0.0.1:${port}`, webDir: fileURLToPath(new URL("../../packages/web/dist/", import.meta.url)) });
  value.scenario.controls.delayMs = 1800;
});
After({ tags: "@layer:e2e and @story:rule-library-import", timeout: 60000 }, async function (this: ApiWorld) {
  const value = states.get(this); if (!value) return;
  try { await browser(value, "close"); } finally { try { await value.scenario.stop(); } finally { await rm(value.directory, { recursive: true, force: true }); } }
});
Given("服务管理员张伟打开规范页的规范库标签", { timeout: 60000 }, async function (this: ApiWorld) {
  const value = state(this); await browser(value, "open", `${value.scenario.app.baseUrl}/?rules=1&tab=library`);
  await browser(value, "fill", "#account-username", "zhang.wei"); await browser(value, "fill", "#account-password", fixturePassword);
  await browser(value, "click", 'button[type="submit"]'); await browser(value, "wait", 'section[aria-label="规范库"]');
  assert.match(await browser(value, "snapshot"), /导入规范/);
});
When("张伟通过导入规范上传研发编程语言 checklist", async function (this: ApiWorld) {
  const value = state(this); await browser(value, "find", "role", "button", "click", "--name", "导入规范");
  await browser(value, "upload", 'input[type="file"]', value.file);
  await browser(value, "find", "role", "button", "click", "--name", "上传文件");
});
Then("页面显示规划与生成进度，完成后展示按文件分组的规范集预览", { timeout: 60000 }, async function (this: ApiWorld) {
  const value = state(this), deadline = Date.now() + 45000;
  let text = "";
  while (Date.now() < deadline) {
    text = await browser(value, "get", "text", 'section[aria-label="企业规范导入"]');
    for (const phase of ["规划中", "生成中"]) if (text.includes(phase)) value.seen.add(phase);
    if (text.includes("待发布") && text.includes("研发编程语言 · Go")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(value.seen.has("规划中"), text); assert.ok(value.seen.has("生成中"), text);
  assert.match(text, /待发布/); assert.match(text, /已结束 \d+ \/ \d+ 个片段/);
  assert.match(text, /研发编程语言 checklist.md/); assert.match(text, /研发编程语言 · C\/C\+\+/); assert.match(text, /研发编程语言 · Go/);
  assert.doesNotMatch(await browser(value, "snapshot"), /请求未完成/);
  await browser(value, "scrollintoview", 'article[aria-label="预览 研发编程语言 · Go"]');
  await browser(value, "screenshot", join(value.directory, "preview.png"));
});
When("张伟勾选 Go 规范集并发布", async function (this: ApiWorld) {
  const value = state(this); await browser(value, "check", 'input[aria-label="发布 研发编程语言 · Go"]');
  assert.match(await browser(value, "is", "checked", 'input[aria-label="发布 研发编程语言 · Go"]'), /true/);
  await browser(value, "scroll", "up", "3000");
  await browser(value, "find", "role", "button", "click", "--name", "发布所选规范集");
});
Then("规范库标签中出现标记为企业导入的 Go 规范集", async function (this: ApiWorld) {
  const value = state(this), selector = 'article[aria-label="研发编程语言 · Go"]';
  await browser(value, "wait", selector); const text = await browser(value, "get", "text", selector);
  assert.match(text, /企业导入/); assert.match(text, /来源文件：研发编程语言 checklist.md/);
  await browser(value, "scrollintoview", selector); await browser(value, "screenshot", join(value.directory, "published.png"));
});

async function reveal(value: BrowserState, selector: string) {
  await browser(value, "eval", `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior: "instant", block: "center"}); true`);
}
async function evaluate<T>(value: BrowserState, script: string): Promise<T> {
  return JSON.parse(await browser(value, "eval", script)) as T;
}
async function login(value: BrowserState, username: string) {
  await browser(value, "open", `${value.scenario.app.baseUrl}/?rules=1&tab=library`);
  await browser(value, "fill", "#account-username", username);
  await browser(value, "fill", "#account-password", fixturePassword);
  await browser(value, "click", 'button[type="submit"]');
  await browser(value, "wait", 'section[aria-label="规范库"] .library-card');
}
const measurements = new WeakMap<ApiWorld, Record<string, number>>();
Given("服务管理员张伟的导入已生成 20 个规范集、共 1400 条条目", { timeout: 180000 }, async function (this: ApiWorld) {
  const value = state(this); value.scenario.controls.delayMs = 0; value.scenario.controls.large = true;
  const id = await value.scenario.upload([{ name: "支付安全 checklist.md", text: `# 支付安全 checklist\n\n${Array.from({ length: 20 }, (_, index) => `## 支付安全 · ${String(index + 1).padStart(2, "0")}\n\n${index === 0 ? ["输入校验", "错误处理", "权限检查", "资源释放"].map((title) => `### ${title}\n\n${"必须检查支付请求边界。\n".repeat(400)}`).join("\n") : "必须检查支付请求边界。"}`).join("\n\n")}` }]);
  const preview = await value.scenario.wait(id);
  assert.equal(preview.status, "ready", JSON.stringify(preview.chunks.filter((chunk) => chunk.status === "failed"))); assert.equal(preview.sets.length, 20);
  assert.equal(preview.sets.reduce((sum, set) => sum + set.entry_count, 0), 1400);
  assert.equal((await value.scenario.app.request("/api/admin/members", { username: "li.admin", name: "李娜", password: fixturePassword, role: "admin" })).status, 201);
  measurements.set(this, {});
  await login(value, "zhang.wei");
});
When("张伟打开导入预览，全选规范集并发布", { timeout: 60000 }, async function (this: ApiWorld) {
  const value = state(this), metrics = measurements.get(this)!;
  await browser(value, "find", "role", "button", "click", "--name", "导入规范");
  await browser(value, "wait", '.library-import li button');
  metrics.previewMs = await evaluate<number>(value, `new Promise(resolve => {
    const start = performance.now();
    const observer = new MutationObserver(() => {
      if (document.querySelectorAll('[aria-label="导入预览"] .library-card').length === 20) {
        observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
    document.querySelector('.library-import li button').click();
  })`);
  assert.equal(await evaluate(value, `document.querySelectorAll('[aria-label="导入预览"] .library-entry').length`), 0);
  const previewCard = 'article[aria-label="预览 支付安全 · 01"]';
  await reveal(value, `${previewCard} > details > summary`);
  await browser(value, "click", `${previewCard} > details > summary`);
  await browser(value, "wait", `${previewCard} .library-entry`);
  assert.equal(await evaluate(value, `document.querySelectorAll('[aria-label="导入预览"] .library-entry').length`), 200);
  assert.equal(await evaluate(value, `document.querySelectorAll('[aria-label="导入预览"] pre').length`), 0);
  await reveal(value, `${previewCard} .library-entry:first-of-type > summary`);
  await browser(value, "click", `${previewCard} .library-entry:first-of-type > summary`);
  await browser(value, "wait", `${previewCard} pre`);
  assert.equal(await evaluate(value, `document.querySelectorAll('[aria-label="导入预览"] pre').length`), 2);
  await reveal(value, `${previewCard} > details > summary`);
  await browser(value, "click", `${previewCard} > details > summary`);
  // 待发布时先观察一次，发布后再观察，防止只在发布动作后停止轮询。
  metrics.readyRequests = await evaluate<number>(value, `new Promise(resolve => {
    const start = performance.now();
    setTimeout(() => resolve(performance.getEntriesByType('resource').filter(entry => entry.startTime >= start && /\\/api\\/rule-library-imports(?:\\/[^/]+)?$/.test(new URL(entry.name).pathname)).length), 10000);
  })`);
  assert.equal(metrics.readyRequests, 0);
  await reveal(value, '[aria-label="导入预览"] > div input[type="checkbox"]');
  await browser(value, "check", '[aria-label="导入预览"] > div input[type="checkbox"]');
  await evaluate(value, `(() => {
    window.importPublishTiming = { start: 0, clickMs: null, scrollMs: null };
    document.addEventListener('click', event => {
      if (event.target.closest('button')?.textContent.includes('发布所选规范集')) {
        window.importPublishTiming.start = performance.now();
        setTimeout(() => {
          document.querySelector('article[aria-label="预览 支付安全 · 01"] > details > summary').click();
          window.importPublishTiming.clickMs = performance.now() - window.importPublishTiming.start;
          window.scrollTo(0, document.body.scrollHeight);
        }, 0);
      }
    }, {capture:true});
    window.addEventListener('scroll', () => { if (window.importPublishTiming.start) window.importPublishTiming.scrollMs = performance.now() - window.importPublishTiming.start; });
    return true;
  })()`);
  await browser(value, "find", "role", "button", "click", "--name", "发布所选规范集（20）");
});
Then("页面在操作期间保持响应，发布后提示已发布 20 个规范集", { timeout: 60000 }, async function (this: ApiWorld) {
  const value = state(this), metrics = measurements.get(this)!;
  await browser(value, "wait", "--text", "已发布 20 个规范集");
  const timing = await evaluate<{ delay: number; clickMs: number; scrollMs: number }>(value, `(() => {
    const entry = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname.endsWith('/publish'));
    return {delay: entry.startTime - window.importPublishTiming.start, clickMs: window.importPublishTiming.clickMs, scrollMs: window.importPublishTiming.scrollMs};
  })()`);
  metrics.publishRequestMs = timing.delay; metrics.clickMs = timing.clickMs; metrics.scrollMs = timing.scrollMs;
  assert.ok(timing.delay < 1000, JSON.stringify(timing)); assert.ok(timing.clickMs !== null && timing.clickMs < 1000, JSON.stringify(timing)); assert.ok(timing.scrollMs !== null && timing.scrollMs < 1000, JSON.stringify(timing));
  assert.match(await browser(value, "get", "text", '[aria-label="导入预览"]'), /已发布 20 个规范集/);
});
Then("导入结束后页面不再定时刷新", { timeout: 30000 }, async function (this: ApiWorld) {
  const value = state(this), metrics = measurements.get(this)!;
  metrics.publishedRequests = await evaluate<number>(value, `new Promise(resolve => {
    const start = performance.now();
    setTimeout(() => resolve(performance.getEntriesByType('resource').filter(entry => entry.startTime >= start && /\\/api\\/rule-library-imports(?:\\/[^/]+)?$/.test(new URL(entry.name).pathname)).length), 10000);
  })`);
  assert.equal(metrics.publishedRequests, 0);
});
When("团队管理员李娜打开规范库标签并展开其中一个导入规范集", { timeout: 60000 }, async function (this: ApiWorld) {
  const value = state(this), metrics = measurements.get(this)!;
  await browser(value, "close");
  await browser(value, "open", `${value.scenario.app.baseUrl}/?rules=1&tab=library`);
  await browser(value, "fill", "#account-username", "li.admin"); await browser(value, "fill", "#account-password", fixturePassword);
  metrics.libraryMs = await evaluate<number>(value, `new Promise(resolve => {
    const start = performance.now();
    const observer = new MutationObserver(() => {
      if (document.querySelector('article[aria-label="支付安全 · 20"]')) {
        observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      }
    }); observer.observe(document.body, {childList:true, subtree:true}); document.querySelector('button[type="submit"]').click();
  })`);
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry').length`), 0);
  const requests = await evaluate<Array<{ path: string; transferSize: number; encodedBodySize: number }>>(value, `performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname.startsWith('/api/')).map(entry => ({path:new URL(entry.name).pathname,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize}))`);
  assert.ok(requests.some((entry) => entry.path === "/api/rule-library" && entry.transferSize > 0), "计时应包含规范库的真实网络响应");
  metrics.libraryMaxTransferBytes = Math.max(...requests.map((entry) => entry.transferSize));
  assert.ok(metrics.libraryMaxTransferBytes <= 200 * 1024, `首屏最大接口传输体积：${Math.max(...requests.map((entry) => entry.transferSize))}`);
  assert.ok(!requests.some((entry) => /^\/api\/rule-library\/[^/]+\/entries$/.test(entry.path)), "未展开规范集不能请求条目");
  await reveal(value, 'article[aria-label="支付安全 · 01"] .library-entries > summary');
  await browser(value, "click", 'article[aria-label="支付安全 · 01"] .library-entries > summary');
  await browser(value, "wait", 'article[aria-label="支付安全 · 01"] .library-entry');
});
Then("规范库只渲染展开的规范集条目，条目展开后才显示代码示例", { timeout: 60000 }, async function (this: ApiWorld) {
  const value = state(this), metrics = measurements.get(this)!;
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry').length`), 200);
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry pre').length`), 0);
  await reveal(value, 'article[aria-label="支付安全 · 01"] .library-entry:first-of-type details > summary');
  await browser(value, "click", 'article[aria-label="支付安全 · 01"] .library-entry:first-of-type details > summary');
  await browser(value, "wait", 'article[aria-label="支付安全 · 01"] .library-entry pre');
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry pre').length`), 2);
  metrics.applyMs = await evaluate<number>(value, `new Promise(resolve => {
    const card = document.querySelector('article[aria-label="支付安全 · 01"]');
    const start = performance.now();
    window.libraryApplyStarted = start;
    const observer = new MutationObserver(() => {
      if (card.textContent.includes('已创建并启用 200 条规则') && card.querySelectorAll('.rule-status-active').length === 200) {
        observer.disconnect(); requestAnimationFrame(() => resolve(performance.now() - start));
      }
    }); observer.observe(card, {childList:true, subtree:true}); card.querySelector('.library-card-actions button').click();
  })`);
  assert.ok(metrics.applyMs < 10000, `应用耗时 ${metrics.applyMs} 毫秒`);
  metrics.applyRefreshRequests = await evaluate<number>(value, `performance.getEntriesByType('resource').filter(entry => entry.startTime >= window.libraryApplyStarted && new URL(entry.name).pathname === '/api/rule-library').length`);
  assert.equal(metrics.applyRefreshRequests, 0, "应用后不应重新读取完整规范库");
  const summary = 'article[aria-label="支付安全 · 01"] .library-entries > summary';
  await reveal(value, summary); await browser(value, "click", summary);
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry').length`), 0);
  await reveal(value, summary); await browser(value, "click", summary);
  await browser(value, "wait", 'article[aria-label="支付安全 · 01"] .library-entry');
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry pre').length`), 0);
  assert.equal(await evaluate(value, `document.querySelectorAll('.library-entry .rule-status-active').length`), 200);
  await this.attach(JSON.stringify(metrics, null, 2), "application/json");
  console.log("规模验证（毫秒、请求数）：", JSON.stringify(metrics));
});
