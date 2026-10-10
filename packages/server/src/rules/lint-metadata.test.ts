import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLintMetadata } from "./lint-metadata.js";

afterEach(() => vi.unstubAllGlobals());

describe("lint 元数据静态解析", () => {
  it("读取直接导出的元数据，支持注释、单双引号、转义和尾逗号", () => {
    const source = `#!/usr/bin/env node
      // 检查器说明
      export const meta = {
        name: '付款检查', description: "金额\\n校验", /* 路径按所在层匹配 */
        paths: ['src/**', "lib/**/*.ts",], script: './check.mjs', args: ['--hook', '--name=\\"test\\"',],
      };
      export function check(input) { return input.files.map(({ path }) => path); }
    `;
    expect(parseLintMetadata(source)).toEqual({ name: "付款检查", description: "金额\n校验", paths: ["src/**", "lib/**/*.ts"],
      script: "./check.mjs", args: ["--hook", '--name="test"'] });
  });

  it("可选字段缺省和空字符串交给调用方回退，路径不在解析阶段过滤", () => {
    expect(parseLintMetadata("export const meta = { paths: ['src/**'] };")).toEqual({ paths: ["src/**"], args: [] });
    expect(parseLintMetadata("export const meta = { name: '', description: '', script: '', paths: ['', '/absolute', '../outside', 'src/**'], args: [] }"))
      .toEqual({ paths: ["", "/absolute", "../outside", "src/**"], args: [] });
  });

  it("未知字段允许嵌套 JSON 值，原型键不会污染结果或继承必填字段", () => {
    expect(parseLintMetadata(`export const meta = { paths: ['src/**'], extra: { values: ['text', -2, 1.5, true, false, null, []] },
      '__proto__': { description: '不应继承' }, constructor: { prototype: { lintParserPolluted: true } } };`))
      .toEqual({ paths: ["src/**"], args: [] });
    expect(Object.prototype).not.toHaveProperty("lintParserPolluted");
    expect(() => parseLintMetadata("export const meta = { '__proto__': { paths: ['src/**'] } }"))
      .toThrow(/paths/);
  });

  it("只解析顶层导出，不从注释、字符串或模板内容中提取伪声明", () => {
    for (const source of ["// export const meta = { paths: ['src/**'] };", 'const text = "export const meta = { paths: [\'src/**\'] };";',
      "const text = `export const meta = { paths: ['src/**'] };`;"]) expect(() => parseLintMetadata(source)).toThrow(/直接声明/);
  });

  it("模块导入、顶层语句和函数执行体均不运行", () => {
    const observed: string[] = [];
    vi.stubGlobal("lintMetadataExecutionProbe", observed);
    expect(parseLintMetadata(`globalThis.lintMetadataExecutionProbe.push('top-level');
      export const meta = { paths: ['src/**'] };
      throw new Error('不得执行');
      export async function check() { globalThis.lintMetadataExecutionProbe.push('checker'); }
      check();`)).toEqual({ paths: ["src/**"], args: [] });
    expect(parseLintMetadata("import 'ureview-fixture-module-that-does-not-exist'; export const meta = { paths: ['src/**'] }; await Promise.resolve();"))
      .toEqual({ paths: ["src/**"], args: [] });
    expect(observed).toEqual([]);
  });

  it.each([
    "{ paths: ['src/**'], name: globalThis.lintMetadataExecutionProbe.push('call') }",
    "{ paths: ['src/**'], name: `${globalThis.lintMetadataExecutionProbe.push('template')}` }",
    "{ paths: ['src/**'], ['name']: 'computed' }",
    "{ paths: ['src/**'], ...{ name: 'spread' } }",
    "{ paths: [...['src/**']] }",
    "{ paths: ['src/**'], get name() { globalThis.lintMetadataExecutionProbe.push('getter'); return 'name'; } }",
    "{ paths: ['src/**'], name() { return 'method'; } }",
    "{ paths: ['src/**'], unknown: { nested: globalThis.lintMetadataExecutionProbe.push('nested') } }",
    "{ paths: ['src/**'], name: 'first' + 'second' }",
    "{ paths: ['src/**'], name: `literal template` }",
    "{ paths }",
    "{ paths: ['src/**'], unknown: undefined }",
    "{ paths: ['src/**'], unknown: /pattern/ }",
    "{ paths: ['src/**'], unknown: 1n }",
    "{ paths: ['src/**'], unknown: 1e999 }",
    "{ paths: ['src/**'], unknown: [,] }",
  ])("拒绝动态或非 JSON 元数据且不执行：%s", (expression) => {
    const observed: string[] = [];
    vi.stubGlobal("lintMetadataExecutionProbe", observed);
    expect(() => parseLintMetadata(`const paths = ['src/**']; export const meta = ${expression};`)).toThrow(/纯字面量/);
    expect(observed).toEqual([]);
  });

  it.each([
    "const meta = { paths: ['src/**'] }; export { meta };",
    "export { meta } from './other.mjs';",
    "export * from './other.mjs';",
    "export default { paths: ['src/**'] };",
    "export let meta = { paths: ['src/**'] };",
    "const value = { paths: ['src/**'] }; export const meta = value;",
    "export const meta = makeMetadata();",
    "export const meta = [{ paths: ['src/**'] }];",
  ])("拒绝非直接对象常量声明：%s", (source) => {
    expect(() => parseLintMetadata(source)).toThrow(/直接声明/);
  });

  it.each([
    "{}", "{ paths: [] }", "{ paths: 'src/**' }", "{ paths: [42] }", "{ paths: [null] }",
    "{ paths: ['src/**'], name: 42 }", "{ paths: ['src/**'], description: null }",
    "{ paths: ['src/**'], script: false }", "{ paths: ['src/**'], args: '--hook' }", "{ paths: ['src/**'], args: [1] }",
  ])("拒绝字段缺失或类型错误：%s", (expression) => {
    expect(() => parseLintMetadata(`export const meta = ${expression};`)).toThrow(/lint meta/);
  });

  it("语法错误和重复导出返回中文错误，不泄漏源代码内容", () => {
    for (const source of ["export const meta = { paths: ['src/**'] }; const = PRIVATE_SOURCE", "export const meta = {}; export const meta = {};"]) {
      expect(() => parseLintMetadata(source)).toThrow("lint 文件不是有效的 JavaScript 模块");
    }
  });
});
