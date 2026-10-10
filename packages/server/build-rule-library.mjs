import { cp, rm } from "node:fs/promises";

const source = new URL("./rule-library/", import.meta.url);
const destination = new URL("./dist/rule-library/", import.meta.url);

// 清理旧版本数据，避免已移除的规范集留在发布目录。
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
