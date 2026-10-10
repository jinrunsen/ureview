import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { createScope } from "@deepseek-ai/dsh-scope";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "./host-plugin.js";

let context: Context;

beforeEach(() => {
  context = new Context();
  new SystemPrompt(context, {});
  context.provide("ureviewBootstrap", {
    models: undefined, started: false, onReady: async () => async () => {},
  });
});

afterEach(async () => { await context.fiber.dispose(); });

function expectLanguageLast(text: string) {
  const paragraphs = text.split("\n\n");
  expect(paragraphs.at(-1)).toMatch(/^思考过程（reasoning）、中间说明、回答和解释必须使用简体中文。/);
  expect(paragraphs.filter((paragraph) => paragraph.includes("思考过程（reasoning）"))).toHaveLength(1);
}

describe("宿主的系统提示词语言约束", () => {
  it("后注册的全局和 agent 段落使用任意有限排序值，中文要求仍唯一且位于末段", async () => {
    await apply(context);
    const scope = {};
    const scoped = createScope(context, scope);
    for (const order of [500, 10200, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
      context.systemPrompt.section({ name: `zzz:global:${order}`, order, text: `GLOBAL_${order}` });
      scoped.ctx.systemPrompt.section({ name: `zzz:agent:${order}`, order, text: `AGENT_${order}` });
    }
    for (let index = 0; index < 2; index++) {
      const text = renderPrompt(await context.systemPrompt.assemble({ scope }));
      expectLanguageLast(text);
      for (const order of [500, 10200, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
        expect(text).toContain(`GLOBAL_${order}`);
        expect(text).toContain(`AGENT_${order}`);
      }
    }
  });

  it.each(["before", "after"] as const)("组装监听器注册于宿主 %s 时保留追加内容与变量，中文要求仍唯一且位于末段", async (timing) => {
    if (timing === "after") await apply(context);
    context.on("system-prompt/assemble", async (_assembly, _options, next) => {
      const assembly = await next();
      return { ...assembly, variables: { ...assembly.variables, late_value: "后续插件内容" },
        sections: [...assembly.sections, { name: "zzz:listener", text: "{{late_value}}" }] };
    });
    if (timing === "before") await apply(context);
    const text = renderPrompt(await context.systemPrompt.assemble());
    expect(text).toContain("后续插件内容");
    expectLanguageLast(text);
  });
});
