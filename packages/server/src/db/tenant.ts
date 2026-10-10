import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export const DEFAULT_TEAM_ID = "00000000-0000-4000-8000-000000000001";
const teamStorage = new AsyncLocalStorage<string>();

export function currentTeamId(): string | undefined { return teamStorage.getStore(); }

export function withTeam<T>(teamId: string, run: () => T): T {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(teamId)) throw new Error("团队标识不正确");
  return teamStorage.run(teamId, run);
}

/** 每次借出前设置租户，归还前回滚和清空，事务及并发请求均不共用上下文。 */
export function createTenantPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  const connect = pool.connect.bind(pool);
  async function acquire(): Promise<pg.PoolClient> {
    const teamId = currentTeamId() ?? "";
    const client = await connect();
    const release = client.release.bind(client);
    try { await client.query("SELECT set_config('app.team_id',$1,false)", [teamId]); }
    catch (error) { release(true); throw error; }
    let released = false;
    client.release = (error?: Error | boolean) => {
      if (released) throw new Error("数据库连接已归还");
      released = true;
      if (error) { release(error); return; }
      void client.query("ROLLBACK; RESET app.team_id").then(() => release(), () => release(true));
    };
    return client;
  }
  function scopedConnect(): Promise<pg.PoolClient>;
  function scopedConnect(callback: (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: Error | boolean) => void) => void): void;
  function scopedConnect(callback?: (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: Error | boolean) => void) => void): Promise<pg.PoolClient> | void {
    if (!callback) return acquire();
    void acquire().then((client) => callback(undefined, client, client.release), (error: Error) => callback(error, undefined, () => {}));
  }
  pool.connect = scopedConnect;
  return pool;
}

export async function assertTenantRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
  );
  if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls) {
    throw new Error("数据库应用角色必须为 NOSUPERUSER NOBYPASSRLS，请先运行数据库角色初始化");
  }
}
