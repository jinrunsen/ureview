export interface ImportSection { id: string; parentId: string | null; title: string; path: string; level: number; text: string; characters: number; omitted: boolean }
export interface ImportChunk { sectionId: string; path: string; text: string }
export interface SlicedFile { sections: ImportSection[]; chunks: ImportChunk[] }
const limit = 8000;

function blocks(text: string): string[] {
  const result: string[] = [];
  let current = "", fence = "", fenceLength = 0, listIndent: number | null = null, blank = false;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const list = !fence ? /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(line) : null;
    const indent = list?.[1]!.length;
    if (!fence && current && (listIndent === null && (marker || list)
      || indent !== undefined && listIndent !== null && indent <= listIndent
      || blank && listIndent !== null && line.trim() && !/^\s/.test(line) && !list && !marker)) {
      result.push(current); current = ""; listIndent = null;
    }
    if (list && listIndent === null) listIndent = indent!;
    if (marker && !fence) { fence = marker[0]!; fenceLength = marker.length; }
    else if (marker && marker[0] === fence && marker.length >= fenceLength && new RegExp(`^ {0,3}${fence}{${fenceLength},}\\s*$`).test(line)) {
      fence = "";
      if (listIndent === null) { result.push(current + line); current = ""; blank = false; continue; }
    }
    current += line;
    blank = !line.trim();
    if (!fence && blank && listIndent === null) { result.push(current); current = ""; }
  }
  if (current) result.push(current);
  return result;
}
function splitText(text: string): string[] {
  const result: string[] = []; let current = "";
  const append = (part: string) => { if (current && current.length + part.length > limit) { result.push(current); current = ""; } current += part; };
  for (const block of blocks(text)) {
    // 围栏和列表项保持完整；普通超长段落按行切，单行不切断字符。
    if (block.length > limit && !/^\s*(?:`{3,}|~{3,}|[-+*]\s|\d+[.)]\s)/.test(block)) block.split(/(?<=\n)/).forEach(append);
    else append(block);
  }
  if (current.trim()) result.push(current);
  return result;
}
export function sliceImportFile(filename: string, text: string, prefix = "section", boundaries: ReadonlySet<string> = new Set()): SlicedFile {
  const sections: ImportSection[] = [{ id: `${prefix}-0`, parentId: null, title: filename, path: filename, level: 0, text: "", characters: 0, omitted: false }];
  const stack = [sections[0]!]; let fence = "", fenceLength = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const heading = !fence && !/\.txt$/i.test(filename) ? /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      const level = heading[1]!.length;
      while (stack.at(-1)!.level >= level) stack.pop();
      const parent = stack.at(-1)!;
      const section: ImportSection = { id: `${prefix}-${sections.length}`, parentId: parent.id, title: heading[2]!, path: `${parent.path} › ${heading[2]}`, level, text: "", characters: 0, omitted: false };
      sections.push(section); stack.push(section);
    } else stack.at(-1)!.text += line;
    if (marker && !fence) { fence = marker[0]!; fenceLength = marker.length; }
    else if (marker && marker[0] === fence && marker.length >= fenceLength && new RegExp(`^ {0,3}${fence}{${fenceLength},}\\s*$`).test(line)) fence = "";
  }
  const children = (section: ImportSection) => sections.filter((item) => item.parentId === section.id);
  const subtree = (section: ImportSection): string => [section.text, ...children(section).filter((item) => !item.omitted).map((item) => `${"#".repeat(item.level)} ${item.title}\n${subtree(item)}`)].join("");
  for (const section of sections) {
    const title = section.title;
    section.omitted = /^(目录|contents|table of contents)$/i.test(title) && section.text.trim().length > 0
      && section.text.trim().split("\n").filter((line) => line.trim()).every((line) => /^\s*(?:[-+*]|\d+[.)])\s+\[[^\]]+\]\([^)]+\)\s*$/.test(line));
  }
  for (const section of sections) section.characters = subtree(section).length;
  const chunks: ImportChunk[] = [];
  const hasBoundary = (section: ImportSection): boolean => children(section).some((child) => boundaries.has(child.id) || hasBoundary(child));
  function visit(section: ImportSection) {
    if (section.omitted) return;
    const all = subtree(section), nested = children(section);
    if (all.length <= limit && !hasBoundary(section)) { if (all.trim()) chunks.push({ sectionId: section.id, path: section.path, text: all }); }
    else if (nested.length) {
      let pending = "", ownText = false;
      let grouped: ImportSection[] = [];
      const flush = () => {
        if (pending.trim()) {
          const only = !ownText && grouped.length === 1 ? grouped[0] : undefined;
          chunks.push(only ? { sectionId: only.id, path: only.path, text: subtree(only) }
            : { sectionId: section.id, path: section.path, text: pending });
        }
        pending = ""; ownText = false; grouped = [];
      };
      const append = (part: string, child?: ImportSection) => {
        if (pending && pending.length + part.length > limit) flush();
        pending += part;
        if (child) grouped.push(child); else ownText = true;
      };
      for (const part of splitText(section.text)) append(part);
      for (const child of nested) {
        if (child.omitted) continue;
        const content = `${"#".repeat(child.level)} ${child.title}\n${subtree(child)}`;
        if (boundaries.has(child.id) || hasBoundary(child) || content.length > limit) {
          flush(); visit(child);
        } else append(content, child);
      }
      flush();
    }
    else for (const part of splitText(all)) chunks.push({ sectionId: section.id, path: section.path, text: part });
  }
  visit(sections[0]!);
  return { sections, chunks };
}
