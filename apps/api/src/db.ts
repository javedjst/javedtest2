import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

export type Db = pg.PoolClient;

/**
 * A pg client runs one query at a time. Several services fan out with Promise.all on the same
 * transaction, so queue queries per client instead of relying on every caller to await in order.
 */
function serialised(client: pg.PoolClient): pg.PoolClient {
  let tail: Promise<unknown> = Promise.resolve();
  const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
  (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = (...args) => {
    const run = tail.then(() => original(...args));
    tail = run.catch(() => undefined);
    return run;
  };
  return client;
}

/**
 * Runs fn inside a transaction scoped to one tenant. Postgres RLS reads app.org_id, so a bug in
 * application code (a missing WHERE org_id = ...) still cannot read another tenant's rows.
 */
export async function withOrg<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = serialised(await pool.connect());
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** For the few lookups that happen before a tenant is known (SECURITY DEFINER functions only). */
export const rawQuery = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  pool.query<T>(text, params);
