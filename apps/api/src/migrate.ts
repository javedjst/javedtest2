import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

/** Applies db/migrations/*.sql in order, once each, as the schema owner (not the app role). */
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const client = new pg.Client({ connectionString: config.MIGRATION_DATABASE_URL });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  console.log(`applying ${file}`);
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(join(dir, file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
await client.end();
console.log('migrations up to date');
