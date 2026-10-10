import type { RuleCategory, RuleSeverity } from "./managed-types.js";
import type { RuleLayer } from "./metadata.js";

export interface LibraryEntry {
  id: string; title: string; originalName: string; summary: string; body: string; check: string; why: string; fix: string;
  goodExample: string; badExample: string; exampleLanguage: string;
  judgement: boolean; category: RuleCategory; severity: RuleSeverity; source: { sourceId: string; reference: string };
}
export interface LibrarySet {
  sourceType?: "builtin" | "imported"; sourceFilename?: string; publishedBy?: string; publishedAt?: string;
  id: string; name: string; judgement?: boolean; layer: RuleLayer; languages: string[]; libraryVersion: string;
  sources: Array<{ id: string; title: string; author: string; url: string; license: string; licenseUrl?: string }>;
  inclusionReasons: Array<{ kind: string; explanation: string }>;
  license: { tier: string; attribution: string; notice: string };
  entries: LibraryEntry[];
}
export interface LibrarySummary extends Omit<LibrarySet, "entries"> { entryCount: number; appliedCount: number }
export interface LibrarySource { setName?: string; sourceFilename?: string; setId: string; entryId: string; version: string; body: string; judgement?: boolean; exampleLanguage?: string }
export interface AppliedLibrarySet extends Omit<LibrarySet, "entries"> {
  entries: Array<LibraryEntry & { appliedRuleId: string | null; appliedVersion: string | null; hasUpdate: boolean }>;
}
export interface LibraryUpdate {
  setId: string; entryId: string; appliedVersion: string; latestVersion: string; hasUpdate: boolean;
  previousJudgement: boolean; currentJudgement: boolean; incomingJudgement: boolean;
  previousBody: string; currentBody: string; incomingBody: string;
  incomingGoodExample: string; incomingBadExample: string; incomingExampleLanguage: string;
}
