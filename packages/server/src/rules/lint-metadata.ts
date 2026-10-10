import { parse, type AnyNode } from "acorn";

export interface LintMetadata {
  name?: string;
  description?: string;
  paths: string[];
  script?: string;
  args: string[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const invalidLiteral = () => new Error("lint meta 必须使用纯字面量，不能包含变量、计算或可执行表达式");

function literal(node: AnyNode): JsonValue {
  if (node.type === "Literal") {
    const value = node.value;
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" &&
    typeof node.argument.value === "number" && Number.isFinite(node.argument.value)) return -node.argument.value;
  if (node.type === "ArrayExpression") return node.elements.map((element) => {
    if (!element) throw invalidLiteral();
    return literal(element);
  });
  if (node.type === "ObjectExpression") return Object.fromEntries(node.properties.map((property) => {
    if (property.type !== "Property" || property.kind !== "init" || property.method || property.shorthand || property.computed) throw invalidLiteral();
    const key = property.key.type === "Identifier" ? property.key.name
      : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : undefined;
    if (key === undefined) throw invalidLiteral();
    return [key, literal(property.value)];
  }));
  throw invalidLiteral();
}

function strings(value: JsonValue | undefined, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`lint meta 的 ${field} 必须是字符串列表`);
  return value as string[];
}

/** 仅解析直接导出的常量；模块的导入、顶层语句与检查器执行体均不运行。 */
export function parseLintMetadata(source: string): LintMetadata {
  let module;
  try { module = parse(source, { ecmaVersion: "latest", sourceType: "module" }); }
  catch { throw new Error("lint 文件不是有效的 JavaScript 模块"); }
  const declarations = module.body.flatMap((statement) => statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration" && statement.declaration.kind === "const"
    ? statement.declaration.declarations : []);
  const initializer = declarations.find((declaration) => declaration.id.type === "Identifier" && declaration.id.name === "meta")?.init;
  if (!initializer || initializer.type !== "ObjectExpression") throw new Error("lint 文件需要直接声明 export const meta = {…}");
  const metadata = literal(initializer) as Record<string, JsonValue>;
  const paths = strings(metadata.paths, "paths");
  if (!paths.length) throw new Error("lint meta 的 paths 必须是非空字符串列表");
  const result: LintMetadata = { paths, args: Object.hasOwn(metadata, "args") ? strings(metadata.args, "args") : [] };
  for (const field of ["name", "description", "script"] as const) {
    if (!Object.hasOwn(metadata, field)) continue;
    if (typeof metadata[field] !== "string") throw new Error(`lint meta 的 ${field} 必须是字符串`);
    if (metadata[field]) result[field] = metadata[field];
  }
  return result;
}
