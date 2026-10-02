import type { Db } from '../db.js';
import { local } from '../ai/index.js';
import type { NormalizedDocument, NormalizedMessage } from '../integrations/types.js';

/** Upserts synced items and enriches each message with priority, category, action and deadline. */
export async function ingestMessages(db: Db, orgId: string, ownerUserId: string, integrationId: string | null, msgs: NormalizedMessage[]): Promise<number> {
  const vips = await db.query<{ email: string }>('SELECT email FROM contacts WHERE is_vip');
  const vipSet = new Set(vips.rows.map((v) => v.email?.toLowerCase()));
  let n = 0;
  for (const m of msgs) {
    const c = m.direction === 'inbound'
      ? local.classify({ source: m.source, subject: m.subject, body: m.body, senderName: m.senderName, senderAddress: m.senderAddress, isVip: vipSet.has(m.senderAddress?.toLowerCase() ?? ''), kind: m.kind, now: m.sentAt })
      : null;
    let threadId: string | null = null;
    if (m.threadExternalId) {
      const t = await db.query<{ id: string }>(
        `INSERT INTO threads (org_id, integration_id, source, external_id, subject, last_message_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (org_id, source, external_id) DO UPDATE SET last_message_at = GREATEST(threads.last_message_at, EXCLUDED.last_message_at)
         RETURNING id`,
        [orgId, integrationId, m.source, m.threadExternalId, m.subject ?? null, m.sentAt],
      );
      threadId = t.rows[0]!.id;
    }
    const r = await db.query(
      `INSERT INTO messages (org_id, owner_user_id, integration_id, thread_id, source, kind, external_id, sender_name, sender_address, subject, body, sent_at, direction, summary, priority, category, required_action, deadline, acl, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (org_id, source, external_id) DO NOTHING`,
      [orgId, ownerUserId, integrationId, threadId, m.source, m.kind, m.externalId, m.senderName ?? null, m.senderAddress ?? null, m.subject ?? null, m.body, m.sentAt, m.direction,
       c?.summary ?? null, c?.priority ?? null, c?.category ?? null, c?.requiredAction ?? null, c?.deadline ?? null, m.acl, m.direction === 'outbound' ? 'waiting' : 'open'],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function ingestDocuments(db: Db, orgId: string, integrationId: string | null, docs: NormalizedDocument[]): Promise<number> {
  let n = 0;
  for (const d of docs) {
    const r = await db.query(
      `INSERT INTO documents (org_id, integration_id, source, external_id, title, url, body, acl, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (org_id, source, external_id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, acl = EXCLUDED.acl, updated_at = EXCLUDED.updated_at`,
      [orgId, integrationId, d.source, d.externalId, d.title, d.url ?? null, d.body, d.acl, d.updatedAt],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
