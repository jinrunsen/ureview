import { ruleLayers, ruleLanguages, type RuleLayer } from "./metadata.js";
import type { SlicedFile } from "./import-slicing.js";
export interface ImportPlan { sets: Array<{ name: string; layer: RuleLayer; languages: string[]; sectionIds: string[] }>; skipped: Array<{ sectionId: string; reason: string }> }
export function validateImportPlan(value: unknown, file: SlicedFile): ImportPlan {
  const plan = value as ImportPlan;
  if (!plan || !Array.isArray(plan.sets) || !Array.isArray(plan.skipped)) throw new Error("请提交 sets 与 skipped 列表");
  const assigned = new Set<string>();
  const assign = (id: string) => {
    if (!file.sections.some((section) => section.id === id)) throw new Error(`章节不存在：${id}`);
    if (assigned.has(id)) throw new Error(`章节重复分配：${id}`);
    assigned.add(id);
  };
  for (const set of plan.sets) {
    if (typeof set.name !== "string" || !set.name.trim() || set.name.length > 80) throw new Error("规范集名称须为 1 到 80 个字符");
    if (!ruleLayers.includes(set.layer) || !Array.isArray(set.languages) || set.languages.some((language) => !ruleLanguages.includes(language)) || new Set(set.languages).size !== set.languages.length) throw new Error("规范集层级或语言无效");
    if (!Array.isArray(set.sectionIds) || !set.sectionIds.length) throw new Error("规范集须分配章节");
    set.sectionIds.forEach(assign);
  }
  for (const item of plan.skipped) { if (typeof item.reason !== "string" || !item.reason.trim()) throw new Error("跳过章节须填写理由"); assign(item.sectionId); }
  for (const chunk of file.chunks) {
    let section = file.sections.find((item) => item.id === chunk.sectionId);
    while (section && !assigned.has(section.id)) section = file.sections.find((item) => item.id === section!.parentId);
    if (!section) throw new Error(`片段没有归属：${chunk.path}`);
  }
  if (!assigned.size) throw new Error("至少提交一个规范集或跳过整个文件");
  return plan;
}

/** 与最近已分配祖先归属相同时继承，避免模型枚举子章节改变切片。 */
export function importAssignmentBoundaries(file: SlicedFile, assignments: ReadonlyMap<string, { setId: string | null }>): Set<string> {
  const sections = new Map(file.sections.map((section) => [section.id, section]));
  const boundaries = new Set<string>();
  for (const [id, assignment] of assignments) {
    let parent = sections.get(id)?.parentId;
    while (parent && !assignments.has(parent)) parent = sections.get(parent)?.parentId;
    if (!parent || assignments.get(parent)!.setId !== assignment.setId) boundaries.add(id);
  }
  return boundaries;
}
