/**
 * Agent Note 的类别闭集。
 *
 * 加一个类别要同时改这里和 `.agents/notes/README.md` 的分类表——闸门
 * 认这个常量，人认那张表，两边不一致就会出现「目录建了但闸门拒收」。
 */
export const NOTE_CLASSES = [
  "feature",
  "bug-fix",
  "simplification",
  "architecture",
  "process",
  "testing",
] as const;

/** 生命周期目录。`archived` 是冻结树，内容不许再改。 */
export const NOTE_LIFECYCLES = ["proposed", "implemented", "rejected", "archived"] as const;

export type NoteClass = (typeof NOTE_CLASSES)[number];
export type NoteLifecycle = (typeof NOTE_LIFECYCLES)[number];
