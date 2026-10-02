import { config } from '../config.js';
import type { Db } from '../db.js';
import type { AdapterContext, Credentials } from '../integrations/types.js';
import { decryptSecret, encryptSecret, localKeyWrapper } from '../security/crypto.js';

const wrapper = localKeyWrapper(config.MASTER_KEY, config.MASTER_KEY_ID);

export async function saveCredentials(db: Db, orgId: string, integrationId: string, c: Credentials): Promise<void> {
  const access = encryptSecret(c.accessToken, wrapper, integrationId);
  const refresh = c.refreshToken ? encryptSecret(c.refreshToken, wrapper, integrationId) : null;
  await db.query(
    `INSERT INTO oauth_credentials (org_id, integration_id, access_token_enc, refresh_token_enc, key_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (integration_id) DO UPDATE SET access_token_enc = $3, refresh_token_enc = COALESCE($4, oauth_credentials.refresh_token_enc), key_id = $5, expires_at = $6, updated_at = now()`,
    [orgId, integrationId, access, refresh, wrapper.keyId, c.expiresAt ?? null],
  );
}

/** Loads and decrypts credentials into an AdapterContext. Called only from backend tool code. */
export async function loadAdapterContext(db: Db, orgId: string, integrationId: string, persist: (c: Credentials) => Promise<void>): Promise<AdapterContext> {
  const r = await db.query(
    `SELECT i.user_id, i.config, i.external_account, c.access_token_enc, c.refresh_token_enc, c.expires_at
     FROM integrations i JOIN oauth_credentials c ON c.integration_id = i.id
     WHERE i.id = $1 AND i.status = 'connected'`,
    [integrationId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('Integration is not connected');
  return {
    integrationId, orgId, userId: row.user_id,
    config: { ...row.config, email: row.external_account },
    credentials: {
      accessToken: decryptSecret(row.access_token_enc, wrapper, integrationId),
      refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc, wrapper, integrationId) : undefined,
      expiresAt: row.expires_at ?? undefined,
    },
    onTokenRefresh: persist,
  };
}
