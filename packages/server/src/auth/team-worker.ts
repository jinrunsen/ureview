import { withTeam } from "../db/tenant.js";

/** 后台任务逐团队借用同一 RLS 通道，关闭时等待当前任务释放连接。 */
export function startTeamWorker(teamIds: () => Promise<string[]>, execute: (teamId: string) => Promise<unknown>, intervalMs = 250): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const poll = async () => {
    try {
      for (const teamId of await teamIds()) {
        if (stopped) break;
        try { await withTeam(teamId, () => execute(teamId)); }
        catch { console.error("团队后台任务暂时未完成，将重试"); }
      }
    } catch { console.error("暂时无法读取团队列表，将重试"); }
    if (!stopped) timer = setTimeout(() => { active = poll(); }, intervalMs);
  };
  active = poll();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
