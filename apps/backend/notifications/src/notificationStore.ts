import { randomUUID } from "node:crypto";

export type NotificationCategory = "transaction" | "system" | "marketing" | "security";
export interface InAppNotification {
  id: string; userId: string; category: NotificationCategory; type: string; title: string; message: string;
  actionUrl?: string; actionLabel?: string; imageUrl?: string; metadata: Record<string, unknown>;
  read: boolean; archived: boolean; createdAt: string; readAt?: string; expiresAt?: string;
}
export interface NotificationQuery {
  userId: string; category?: NotificationCategory; read?: boolean; archived?: boolean;
  since?: string; search?: string; limit?: number; offset?: number;
}
export interface NotificationDb { query(text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> }
interface NotificationRow extends Record<string, unknown> {
  id: string; user_id: string; category: NotificationCategory; type: string; title: string; message: string;
  action_url: string | null; action_label: string | null; image_url: string | null;
  metadata: Record<string, unknown>; read: boolean; archived: boolean;
  created_at: Date | string; read_at: Date | string | null; expires_at: Date | string | null;
}
const columns = `id, user_id, category, type, title, message, action_url, action_label,
  image_url, metadata, read, archived, created_at, read_at, expires_at`;
const iso = (value: Date | string) => new Date(value).toISOString();
function mapRow(row: NotificationRow): InAppNotification {
  return {
    id: row.id, userId: row.user_id, category: row.category, type: row.type, title: row.title, message: row.message,
    metadata: row.metadata ?? {}, read: row.read, archived: row.archived, createdAt: iso(row.created_at),
    ...(row.action_url ? { actionUrl: row.action_url } : {}), ...(row.action_label ? { actionLabel: row.action_label } : {}),
    ...(row.image_url ? { imageUrl: row.image_url } : {}), ...(row.read_at ? { readAt: iso(row.read_at) } : {}),
    ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
  };
}
export async function createNotification(db: NotificationDb, input: Omit<InAppNotification, "id" | "createdAt" | "read" | "archived"> & Partial<Pick<InAppNotification, "id" | "createdAt" | "read" | "archived">>): Promise<InAppNotification> {
  const result = await db.query(`INSERT INTO in_app_notifications (${columns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${columns}`, [
    input.id ?? randomUUID(), input.userId, input.category, input.type, input.title, input.message, input.actionUrl ?? null,
    input.actionLabel ?? null, input.imageUrl ?? null, input.metadata, input.read ?? false, input.archived ?? false,
    input.createdAt ?? new Date().toISOString(), input.readAt ?? null, input.expiresAt ?? null,
  ]);
  return mapRow(result.rows[0] as NotificationRow);
}
export async function listNotifications(db: NotificationDb, query: NotificationQuery): Promise<InAppNotification[]> {
  const where = ["user_id = $1", "(expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)"]; const params: unknown[] = [query.userId];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (query.category) add("category = ?", query.category); if (query.read !== undefined) add("read = ?", query.read);
  if (query.archived !== undefined) add("archived = ?", query.archived); if (query.since) add("created_at >= ?", query.since);
  if (query.search?.trim()) { params.push(`%${query.search.trim()}%`); where.push(`(title ILIKE $${params.length} OR message ILIKE $${params.length} OR type ILIKE $${params.length})`); }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100); const offset = Math.max(query.offset ?? 0, 0); params.push(limit, offset);
  const result = await db.query(`SELECT ${columns} FROM in_app_notifications WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return result.rows.map((row) => mapRow(row as NotificationRow));
}
export async function bulkUpdateNotifications(db: NotificationDb, userId: string, ids: string[], action: "read" | "archive"): Promise<number> {
  if (ids.length === 0) return 0; const field = action === "read" ? "read" : "archived"; const readAt = action === "read" ? ", read_at = CURRENT_TIMESTAMP" : "";
  const result = await db.query(`UPDATE in_app_notifications SET ${field} = TRUE${readAt} WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids]);
  return result.rowCount ?? result.rows.length;
}