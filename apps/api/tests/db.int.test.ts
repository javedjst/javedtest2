import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration tests against a real Postgres with the migrations applied.
 * Run:  TEST_DB=1 MIGRATION_DATABASE_URL=postgres://postgres@localhost/aiworkhub npm test
 * Skipped by default so `npm test` works without a database.
 */
const enabled = Boolean(process.env.TEST_DB);
const d = describe.skipIf(!enabled);

d('database isolation and approval flow', () => {
  let owner: pg.Client;
  let orgA = ''; let orgB = ''; let userA = ''; let userB = ''; let legalTeam = '';
  let dbm: typeof import('../src/db.js');
  let exec: typeof import('../src/agents/executor.js');
  let auditm: typeof import('../src/audit.js');

  beforeAll(async () => {
    process.env.DEV_AUTH = 'true';
    dbm = await import('../src/db.js');
    exec = await import('../src/agents/executor.js');
    auditm = await import('../src/audit.js');
    owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    const tag = Math.random().toString(36).slice(2, 8);
    const mk = async (name: string) => (await owner.query('INSERT INTO organisations (name, slug) VALUES ($1,$2) RETURNING id', [name, `${name}-${tag}`])).rows[0].id as string;
    orgA = await mk('ta'); orgB = await mk('tb');
    const mu = async (org: string, email: string, role: string) => (await owner.query('INSERT INTO users (org_id, email, display_name, role) VALUES ($1,$2,$3,$4) RETURNING id', [org, `${tag}-${email}`, email, role])).rows[0].id as string;
    userA = await mu(orgA, 'a@a.test', 'owner'); userB = await mu(orgB, 'b@b.test', 'owner');
    legalTeam = (await owner.query("INSERT INTO teams (org_id, name) VALUES ($1,'legal') RETURNING id", [orgA])).rows[0].id as string;
    await owner.query(`INSERT INTO documents (org_id, source, external_id, title, body, acl) VALUES ($1,'gdrive','open','Open doc','budget plan for launch','{org:*}'), ($1,'gdrive','secret','Secret doc','budget plan litigation settlement',$2)`, [orgA, [`team:${legalTeam}`]]);
    await owner.query(`INSERT INTO documents (org_id, source, external_id, title, body, acl) VALUES ($1,'gdrive','b1','Other tenant doc','budget plan for launch','{org:*}')`, [orgB]);
  });
  afterAll(async () => {
    await owner.query('DELETE FROM organisations WHERE id = ANY($1)', [[orgA, orgB]]).catch(() => undefined);
    await owner.end();
    await dbm.pool.end();
  });

  const ctx = (db: import('../src/db.js').Db, org: string, user: string, role: 'owner' | 'member' = 'owner') =>
    ({ db, orgId: org, userId: user, userName: 'T', userEmail: 'a@a.test', role, origin: 'user' as const });

  it('row level security hides other tenants even with no WHERE clause', async () => {
    const rows = await dbm.withOrg(orgA, async (db) => (await db.query('SELECT org_id FROM documents')).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([orgA]));
  });
  it('a request with no tenant set sees nothing', async () => {
    const c = await dbm.pool.connect();
    try { expect((await c.query('SELECT 1 FROM documents')).rowCount).toBe(0); } finally { c.release(); }
  });
  it('cannot write a row into another tenant', async () => {
    await expect(dbm.withOrg(orgA, (db) => db.query(`INSERT INTO tasks (org_id, title) VALUES ($1, 'x')`, [orgB]))).rejects.toThrow(/row-level security/);
  });
  it('search filters by ACL before ranking', async () => {
    const titles = async (user: string) => dbm.withOrg(orgA, async (db) => {
      const { searchWorkspace } = await import('../src/services/search.js');
      return (await searchWorkspace(ctx(db, orgA, user), 'budget plan litigation settlement')).map((h) => h.title);
    });
    expect(await titles(userA)).toEqual(['Open doc']);
    await owner.query('INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3)', [orgA, legalTeam, userA]);
    expect(await titles(userA)).toEqual(expect.arrayContaining(['Open doc', 'Secret doc']));
  });
  it('audit log is append only', async () => {
    await dbm.withOrg(orgA, (db) => auditm.audit(db, { orgId: orgA, event: 'test.event' }));
    await expect(dbm.withOrg(orgA, (db) => db.query('UPDATE audit_logs SET event = $1', ['x']))).rejects.toThrow();
    await expect(dbm.withOrg(orgA, (db) => db.query('DELETE FROM audit_logs'))).rejects.toThrow();
  });
  it('audit chain verifies after real writes', async () => {
    await dbm.withOrg(orgA, async (db) => { await auditm.audit(db, { orgId: orgA, event: 'one', detail: { z: 1, a: { y: 2, b: 3 } } }); await auditm.audit(db, { orgId: orgA, event: 'two' }); });
    const rows = await dbm.withOrg(orgA, async (db) => (await db.query('SELECT * FROM audit_logs ORDER BY id')).rows);
    expect(auditm.verifyChain(rows)).toBeNull();
  });

  it('high risk send is parked for approval, edited, then executed once', async () => {
    const res = await dbm.withOrg(orgA, (db) => exec.executeTool(ctx(db, orgA, userA), 'communication', 'send_message', { channel: 'email', to: ['x@y.test'], subject: 's', body: 'original' }));
    expect(res.status).toBe('pending_approval');
    const id = (res as { approvalId: string }).approvalId;
    const sentBefore = await dbm.withOrg(orgA, async (db) => (await db.query("SELECT count(*)::int n FROM messages WHERE direction='outbound'")).rows[0].n);
    expect(sentBefore).toBe(0);                                        // nothing left the building
    const out = await dbm.withOrg(orgA, (db) => exec.decideApproval({ db, orgId: orgA }, { userId: userA, role: 'owner' }, id, 'approve', { channel: 'email', to: ['x@y.test'], subject: 's', body: 'edited by human' }));
    expect(out.status).toBe('executed');
    const body = await dbm.withOrg(orgA, async (db) => (await db.query("SELECT body FROM messages WHERE direction='outbound'")).rows[0].body);
    expect(body).toBe('edited by human');                             // what the human approved is what ran
    await expect(dbm.withOrg(orgA, (db) => exec.decideApproval({ db, orgId: orgA }, { userId: userA, role: 'owner' }, id, 'approve'))).rejects.toThrow(/already/);
  });
  it('rejecting runs nothing', async () => {
    const res = await dbm.withOrg(orgA, (db) => exec.executeTool(ctx(db, orgA, userA), 'communication', 'send_message', { channel: 'email', to: ['z@y.test'], body: 'nope' }));
    const out = await dbm.withOrg(orgA, (db) => exec.decideApproval({ db, orgId: orgA }, { userId: userA, role: 'owner' }, (res as { approvalId: string }).approvalId, 'reject'));
    expect(out.status).toBe('rejected');
    expect(await dbm.withOrg(orgA, async (db) => (await db.query("SELECT count(*)::int n FROM messages WHERE body='nope'")).rows[0].n)).toBe(0);
  });
  it('an org deny policy blocks the tool entirely; viewers cannot send', async () => {
    await owner.query("INSERT INTO approval_policies (org_id, action, mode) VALUES ($1,'send_message','deny')", [orgA]);
    const denied = await dbm.withOrg(orgA, (db) => exec.executeTool(ctx(db, orgA, userA), 'communication', 'send_message', { channel: 'email', to: ['q@y.test'], body: 'x' }));
    expect(denied.status).toBe('denied');
    await owner.query("DELETE FROM approval_policies WHERE org_id = $1", [orgA]);
    await expect(dbm.withOrg(orgA, (db) => exec.executeTool({ ...ctx(db, orgA, userA), role: 'viewer' }, 'communication', 'send_message', { channel: 'email', to: ['q@y.test'], body: 'x' }))).rejects.toThrow(/permission/i);
  });
  it('admin-only approvals enforce four eyes', async () => {
    await owner.query("INSERT INTO approval_policies (org_id, action, mode, approver_role) VALUES ($1,'send_message','require_approval','admin')", [orgA]);
    const res = await dbm.withOrg(orgA, (db) => exec.executeTool(ctx(db, orgA, userA), 'communication', 'send_message', { channel: 'email', to: ['q@y.test'], body: 'x' }));
    await expect(dbm.withOrg(orgA, (db) => exec.decideApproval({ db, orgId: orgA }, { userId: userA, role: 'owner' }, (res as { approvalId: string }).approvalId, 'approve'))).rejects.toThrow(/own request/);
    await owner.query("DELETE FROM approval_policies WHERE org_id = $1", [orgA]);
  });
  it('tool failures are recorded without poisoning the transaction', async () => {
    const r = await dbm.withOrg(orgA, async (db) => {
      const out = await exec.executeTool(ctx(db, orgA, userA), 'jira', 'create_jira_ticket', { project: 'SEC', summary: 'Rotate keys' });
      const still = await db.query('SELECT 1 AS ok');
      return { out, ok: still.rows[0].ok };
    });
    expect(r.out.status).toBe('failed');
    expect(r.ok).toBe(1);
  });
});
