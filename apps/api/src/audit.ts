import type { Db } from './db.js';
import { sha256 } from './security/crypto.js';

/** Stable JSON: sorted keys at every level. jsonb does not preserve key order, so hashing must not depend on it. */
export function canonicalJson(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export interface AuditEvent {
  orgId: string;
  actorUserId?: string | null;
  actorKind?: 'user' | 'agent' | 'system' | 'admin';
  event: string;
  target?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

/** Hash chained, append only. Each row commits to the previous row of the same tenant. */
export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${e.orgId}`]);
  const prev = await db.query<{ hash: string }>(
    'SELECT hash FROM audit_logs WHERE org_id = $1 ORDER BY id DESC LIMIT 1',
    [e.orgId],
  );
  const prevHash = prev.rows[0]?.hash ?? '';
  const createdAt = new Date().toISOString();
  const body = canonicalJson([e.orgId, e.actorUserId ?? null, e.actorKind ?? 'user', e.event, e.target ?? null, e.detail ?? {}, createdAt]);
  const hash = sha256(prevHash + body);
  await db.query(
    `INSERT INTO audit_logs (org_id, actor_user_id, actor_kind, event, target, detail, ip, prev_hash, hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.orgId, e.actorUserId ?? null, e.actorKind ?? 'user', e.event, e.target ?? null, JSON.stringify(e.detail ?? {}), e.ip ?? null, prevHash, hash, createdAt],
  );
}

/** Recomputes the chain; returns the id of the first broken row or null when intact. */
export function verifyChain(rows: { id: number; org_id: string; actor_user_id: string | null; actor_kind: string; event: string; target: string | null; detail: unknown; created_at: Date | string; prev_hash: string; hash: string }[]): number | null {
  let prev = '';
  for (const r of rows) {
    const body = canonicalJson([r.org_id, r.actor_user_id, r.actor_kind, r.event, r.target, r.detail, new Date(r.created_at).toISOString()]);
    if (r.prev_hash !== prev || sha256(prev + body) !== r.hash) return r.id;
    prev = r.hash;
  }
  return null;
}
