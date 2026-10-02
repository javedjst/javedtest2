import { pool, withOrg } from '../db.js';
import { requireOperation } from '../integrations/registry.js';
import { loadAdapterContext, saveCredentials } from './credentials.js';
import { ingestDocuments, ingestMessages } from './ingest.js';
import { audit } from '../audit.js';

/**
 * Incremental sync for one integration. Network I/O happens outside any database transaction so a
 * slow provider never holds a connection. In production this runs as a BullMQ job, one per
 * (integration, resource), triggered by webhooks and a periodic schedule; the route just enqueues.
 */
export async function syncIntegration(orgId: string, userId: string, integrationId: string): Promise<{ messages: number; documents: number }> {
  const { provider, ctx, cursor } = await withOrg(orgId, async (db) => {
    const i = (await db.query('SELECT provider FROM integrations WHERE id = $1', [integrationId])).rows[0];
    if (!i) throw new Error('Integration not found');
    const c = await loadAdapterContext(db, orgId, integrationId, (cred) => withOrg(orgId, (d) => saveCredentials(d, orgId, integrationId, cred)));
    const s = (await db.query("SELECT cursor FROM sync_state WHERE integration_id = $1 AND resource = 'default'", [integrationId])).rows[0];
    return { provider: i.provider as string, ctx: c, cursor: (s?.cursor ?? null) as string | null };
  });

  const adapter = requireOperation(provider, 'sync');
  try {
    const result = await adapter.sync!(ctx, cursor);
    return await withOrg(orgId, async (db) => {
      const messages = await ingestMessages(db, orgId, userId, integrationId, result.messages);
      const documents = await ingestDocuments(db, orgId, integrationId, result.documents);
      await db.query(
        `INSERT INTO sync_state (org_id, integration_id, resource, cursor, last_synced_at, status) VALUES ($1,$2,'default',$3,now(),'idle')
         ON CONFLICT (integration_id, resource) DO UPDATE SET cursor = EXCLUDED.cursor, last_synced_at = now(), status = 'idle'`, [orgId, integrationId, result.nextCursor]);
      await db.query("UPDATE integrations SET last_error = NULL, status = 'connected' WHERE id = $1", [integrationId]);
      await audit(db, { orgId, actorUserId: userId, actorKind: 'system', event: 'sync.completed', target: provider, detail: { messages, documents } });
      return { messages, documents };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await withOrg(orgId, (db) => db.query("UPDATE integrations SET last_error = $2, status = CASE WHEN $2 ILIKE '%HTTP 401%' OR $2 ILIKE '%invalid_grant%' THEN 'error' ELSE status END WHERE id = $1", [integrationId, msg.slice(0, 500)]));
    throw err;
  }
}

export { pool };
