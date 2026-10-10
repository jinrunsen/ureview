import { isRecord } from "./api";

export interface SessionPreferences { width: number; full: boolean }
const defaults: SessionPreferences = { width: 65, full: false };
const key = (userId: string) => `ureview:agent-session-layout:${userId}`;

export function readSessionPreferences(userId: string): SessionPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (!isRecord(value)) return { ...defaults };
    return {
      width: typeof value.width === "number" && Number.isFinite(value.width) && value.width >= 45 && value.width <= 100 ? value.width : defaults.width,
      full: typeof value.full === "boolean" ? value.full : defaults.full,
    };
  } catch { return { ...defaults }; }
}

export function saveSessionPreferences(userId: string, value: SessionPreferences): void {
  try { localStorage.setItem(key(userId), JSON.stringify(value)); } catch { /* 浏览器禁用存储时保留当前打开期间的选择。 */ }
}
