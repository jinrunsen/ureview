import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTeam } from "../db/tenant.js";
import type { CredentialCipher } from "../repositories/credentials.js";
import { CollaborationError } from "./types.js";
import { sendWebhook, validateWebhookUrl, type WebhookTransport } from "./webhook.js";
import { assertNotificationAccepted, createNotificationMessage, type NotificationKind } from "./messages.js";
import type { NotificationPayload } from "./notifications.js";

export interface EndpointInput { name: string; kind: NotificationKind; endpoint: string; secret?: string | null }
interface EndpointRow { id: string; name: string; kind: NotificationKind; endpoint_ciphertext: Buffer; secret_ciphertext: Buffer | null; legacy: boolean }
export interface DeliveryOptions { cipher: CredentialCipher; publicOrigin?: string; webhookTransport?: WebhookTransport; retryDelayMs?: number; deliveryIntervalMs?: number }
const context = (id: string, field: string) => `notification:${id}:${field}`;
const mask = "••••••••";

export class NotificationDeliveryService {
  constructor(private readonly pool: pg.Pool, private readonly options: DeliveryOptions) {}

  async migrateLegacySettings(): Promise<void> {
    const teams = await this.pool.query<{ id: string }>("SELECT id FROM teams");
    for (const team of teams.rows) await withTeam(team.id, async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const settings = await client.query<{ endpoint: string | null }>("SELECT endpoint FROM notification_settings FOR UPDATE");
        const endpoint = settings.rows[0]?.endpoint;
        if (endpoint) {
          const existing = await client.query<{ id: string }>("SELECT id FROM notification_endpoints WHERE legacy");
          const id = existing.rows[0]?.id ?? randomUUID();
          if (!existing.rowCount) await client.query(`INSERT INTO notification_endpoints(id,name,kind,endpoint_ciphertext,legacy) VALUES($1,'通用 webhook','webhook',$2,true)`, [id, this.options.cipher.encrypt(endpoint, context(id, "endpoint"))]);
          await client.query("UPDATE notification_deliveries SET endpoint_id=$1 WHERE endpoint_id IS NULL", [id]);
          await client.query("UPDATE notification_settings SET endpoint=NULL");
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    });
  }

  private async counts(endpointId?: string) {
    const result = await this.pool.query<{ status: string; count: string }>(`SELECT status,count(*) FROM notification_deliveries${endpointId ? " WHERE endpoint_id=$1" : ""} GROUP BY status`, endpointId ? [endpointId] : []);
    return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
  }
  private async view(row: EndpointRow) {
    return { id: row.id, name: row.name, kind: row.kind, endpoint: mask, secret: row.secret_ciphertext ? mask : null, deliveries: await this.counts(row.id) };
  }
  async list() {
    const result = await this.pool.query<EndpointRow>("SELECT * FROM notification_endpoints ORDER BY created_at,id");
    return { endpoints: await Promise.all(result.rows.map((row) => this.view(row))) };
  }
  async create(input: EndpointInput, legacy = false) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new CollaborationError(400, "invalid_input", "出口名称为 1 至 100 字");
    if (input.secret && input.kind !== "feishu" && input.kind !== "dingtalk") throw new CollaborationError(400, "invalid_input", "该出口类型不支持签名密钥");
    const endpoint = validateWebhookUrl(input.endpoint).href;
    const id = randomUUID();
    const result = await this.pool.query<EndpointRow>(`INSERT INTO notification_endpoints(id,name,kind,endpoint_ciphertext,secret_ciphertext,legacy) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, name, input.kind, this.options.cipher.encrypt(endpoint, context(id, "endpoint")), input.secret ? this.options.cipher.encrypt(input.secret, context(id, "secret")) : null, legacy]);
    return this.view(result.rows[0]!);
  }
  async update(id: string, input: Partial<Pick<EndpointInput, "name" | "endpoint" | "secret">>) {
    const result = await this.pool.query<EndpointRow>("SELECT * FROM notification_endpoints WHERE id=$1", [id]);
    const row = result.rows[0];
    if (!row) throw new CollaborationError(404, "not_found", "通知出口不存在");
    if (input.name !== undefined && !input.name.trim()) throw new CollaborationError(400, "invalid_input", "请填写出口名称");
    if (input.secret && row.kind !== "feishu" && row.kind !== "dingtalk") throw new CollaborationError(400, "invalid_input", "该出口类型不支持签名密钥");
    const updated = await this.pool.query<EndpointRow>(`UPDATE notification_endpoints SET name=$2,endpoint_ciphertext=$3,secret_ciphertext=$4 WHERE id=$1 RETURNING *`,
      [id, input.name?.trim() ?? row.name, input.endpoint === undefined ? row.endpoint_ciphertext : this.options.cipher.encrypt(validateWebhookUrl(input.endpoint).href, context(id, "endpoint")),
        input.secret === undefined ? row.secret_ciphertext : input.secret ? this.options.cipher.encrypt(input.secret, context(id, "secret")) : null]);
    return this.view(updated.rows[0]!);
  }
  async remove(id: string) {
    const result = await this.pool.query("DELETE FROM notification_endpoints WHERE id=$1", [id]);
    if (!result.rowCount) throw new CollaborationError(404, "not_found", "通知出口不存在");
    return { deleted: true };
  }
  async legacySettings() {
    const result = await this.pool.query<EndpointRow>("SELECT * FROM notification_endpoints WHERE legacy");
    return { endpoint: result.rowCount ? mask : null, deliveries: await this.counts() };
  }
  async configureLegacy(endpoint: string | null) {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM notification_endpoints WHERE legacy");
    const current = result.rows[0];
    if (endpoint === null) {
      if (current) {
        await this.pool.query("UPDATE notification_deliveries SET status='cancelled',last_error=NULL WHERE endpoint_id=$1 AND status='queued'", [current.id]);
        // 兼容接口关闭出口时保留投递结果，已取消记录不再参与发送。
        await this.pool.query("UPDATE notification_deliveries SET endpoint_id=NULL WHERE endpoint_id=$1", [current.id]);
        await this.pool.query("DELETE FROM notification_endpoints WHERE id=$1", [current.id]);
      }
    } else if (current) await this.update(current.id, { endpoint });
    else await this.create({ name: "通用 webhook", kind: "webhook", endpoint }, true);
    return this.legacySettings();
  }

  async deliverNext(): Promise<boolean> {
    const client = await this.pool.connect();
    let delivery: { id: string; payload: NotificationPayload; attempts: number; endpoint: EndpointRow } | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE notification_deliveries SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END,locked_at=NULL,last_error='通知发送中断' WHERE status='sending' AND locked_at < now()-interval '1 minute'");
      const endpoints = await client.query<EndpointRow>(`SELECT e.* FROM notification_endpoints e WHERE e.next_send_at<=now()
        AND NOT EXISTS(SELECT 1 FROM notification_deliveries active WHERE active.endpoint_id=e.id AND active.status='sending')
        AND EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.endpoint_id=e.id AND d.status='queued' AND d.available_at<=now())
        ORDER BY e.next_send_at,e.id FOR UPDATE SKIP LOCKED LIMIT 1`);
      const endpoint = endpoints.rows[0];
      if (!endpoint) { await client.query("COMMIT"); return false; }
      const result = await client.query<{ id: string; payload: NotificationPayload; attempts: number }>(`SELECT id,payload,attempts FROM notification_deliveries WHERE endpoint_id=$1 AND status='queued' AND available_at<=now() ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [endpoint.id]);
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); return false; }
      await client.query("UPDATE notification_endpoints SET next_send_at=clock_timestamp()+($2 * interval '1 millisecond') WHERE id=$1", [endpoint.id, this.options.deliveryIntervalMs ?? 3000]);
      await client.query("UPDATE notification_deliveries SET status='sending',attempts=attempts+1,locked_at=now() WHERE id=$1", [row.id]);
      delivery = { ...row, attempts: row.attempts + 1, endpoint };
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    let failed = false;
    try {
      const endpoint = this.options.cipher.decrypt(delivery.endpoint.endpoint_ciphertext, context(delivery.endpoint.id, "endpoint"));
      const secret = delivery.endpoint.secret_ciphertext ? this.options.cipher.decrypt(delivery.endpoint.secret_ciphertext, context(delivery.endpoint.id, "secret")) : null;
      const message = createNotificationMessage(delivery.endpoint.kind, endpoint, secret, delivery.payload, this.options.publicOrigin ?? "http://localhost:3000");
      const response = await (this.options.webhookTransport ?? sendWebhook)(message.endpoint, message.body, delivery.id);
      assertNotificationAccepted(delivery.endpoint.kind, response);
    } catch { failed = true; }
    await this.pool.query(`WITH postponed AS (
      UPDATE notification_endpoints SET next_send_at=greatest(next_send_at,clock_timestamp()+($3 * interval '1 millisecond')) WHERE id=$2 RETURNING id
    ) UPDATE notification_deliveries SET status=$4,last_error=$5::text,locked_at=NULL,
      delivered_at=CASE WHEN $4='delivered' THEN now() ELSE delivered_at END,
      available_at=CASE WHEN $5::text IS NOT NULL THEN now()+($6 * interval '1 millisecond') ELSE available_at END WHERE id=$1`,
    [delivery.id, delivery.endpoint.id, this.options.deliveryIntervalMs ?? 3000,
      failed ? delivery.attempts >= 4 ? "failed" : "queued" : "delivered", failed ? "通知出口投递失败" : null,
      (this.options.retryDelayMs ?? 5000) * 2 ** (delivery.attempts - 1)]);
    return true;
  }
}
