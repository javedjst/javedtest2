import pg from 'pg';
import { config } from './config.js';
import { ingestDocuments, ingestMessages } from './services/ingest.js';
import type { Db } from './db.js';
import type { NormalizedMessage } from './integrations/types.js';

/**
 * Demo data for local development: one organisation, three users, and a realistic spread of mail,
 * Slack, GitHub, meetings, tasks and documents so every screen has something to show.
 * Idempotent: does nothing if the demo org already exists. Run: npm run seed
 */
const client = new pg.Client({ connectionString: config.MIGRATION_DATABASE_URL });
await client.connect();
const exists = await client.query("SELECT id FROM organisations WHERE slug = 'acme'");
if (exists.rows[0]) {
  console.log('demo org already seeded');
  await client.end();
  process.exit(0);
}

const now = Date.now();
const ago = (h: number) => new Date(now - h * 3_600_000);
const at = (dayOffset: number, hour: number, min = 0) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset, hour, min));
};
const q = <T extends pg.QueryResultRow = any>(sql: string, p: unknown[] = []) => client.query<T>(sql, p);

const org = (await q("INSERT INTO organisations (name, slug, settings) VALUES ('Acme Corp','acme','{\"requireMfa\":false}') RETURNING id")).rows[0].id as string;
const user = async (email: string, name: string, role: string, prefs: object = {}) =>
  (await q('INSERT INTO users (org_id, email, display_name, role, preferences, mfa_enrolled) VALUES ($1,$2,$3,$4,$5,true) RETURNING id', [org, email, name, role, JSON.stringify(prefs)])).rows[0].id as string;
const javed = await user('javed@acme.test', 'Javed Khan', 'owner', { writingStyle: 'concise, friendly, no jargon' });
const priya = await user('priya@acme.test', 'Priya Nair', 'admin');
const sam = await user('sam@acme.test', 'Sam Lee', 'member');
const team = (await q("INSERT INTO teams (org_id, name) VALUES ($1,'Engineering') RETURNING id", [org])).rows[0].id as string;
const legal = (await q("INSERT INTO teams (org_id, name) VALUES ($1,'Legal') RETURNING id", [org])).rows[0].id as string;
for (const u of [javed, priya, sam]) await q('INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3)', [org, team, u]);
await q('INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3)', [org, legal, priya]);

for (const [email, name, company, vip] of [['rahul@cleartrip.example', 'Rahul Mehta', 'Cleartrip', true], ['kartik@acme.test', 'Kartik Rao', 'Acme Corp', false], ['ana@northwind.example', 'Ana Silva', 'Northwind', false]] as const)
  await q('INSERT INTO contacts (org_id, name, email, company, is_vip) VALUES ($1,$2,$3,$4,$5)', [org, name, email, company, vip]);

const me = `user:${javed}`;
const mail = (id: string, h: number, from: string, addr: string, subject: string, body: string, thread: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  externalId: id, threadExternalId: thread, source: 'gmail', kind: 'message', senderName: from, senderAddress: addr, subject, body, sentAt: ago(h), direction: 'inbound', acl: [me, 'mailbox:javed@acme.test'], ...extra,
});
const messages: NormalizedMessage[] = [
  mail('g1', 5, 'Rahul Mehta', 'rahul@cleartrip.example', 'Cleartrip security assessment: report', 'Hi Javed,\n\nThanks for the call yesterday. Javed, please send the security report by Friday. Can you also confirm the retest window? We need it for our audit.\n\nRahul', 't-clear'),
  mail('g2', 52, 'Rahul Mehta', 'rahul@cleartrip.example', 'Cleartrip security assessment: scope', 'Hello, attaching the agreed scope for the assessment. The AWS accounts in scope are production and staging. Let me know if anything is missing.', 't-clear-scope'),
  mail('g3', 1, 'Kartik Rao', 'kartik@acme.test', 'URGENT: production deploy blocked', 'The payments deploy is blocked by a failing migration. We need a decision ASAP, can you approve the rollback today?', 't-deploy'),
  mail('g4', 30, 'Ana Silva', 'ana@northwind.example', 'Re: Q3 partnership agreement', 'Could you review the attached draft and let me know your thoughts? No rush, next week is fine.', 't-ana'),
  mail('g5', 8, 'AWS Billing', 'no-reply@aws.example', 'Your monthly invoice is available', 'Your invoice is available in the billing console. This is an automated message. Unsubscribe from billing emails.', 't-aws', { acl: [me] }),
  mail('g6', 4, 'Priya Nair', 'priya@acme.test', 'Meeting: Cleartrip retest planning', 'Can we schedule a call to plan the retest? I am free tomorrow afternoon.', 't-priya'),
  { externalId: 'g7', threadExternalId: 't-sent', source: 'gmail', kind: 'message', senderName: 'Kartik Rao', subject: 'Endpoint hardening checklist', body: 'Hi Kartik, sharing the endpoint hardening checklist. Can you confirm the rollout date?', sentAt: ago(98), direction: 'outbound', acl: [me] },
  { externalId: 's1', source: 'slack', kind: 'mention', senderName: 'Sam Lee', senderAddress: 'sam@acme.test', subject: '#eng-releases', body: 'Javed, can you update the release notes before the sprint review tomorrow? Also the staging env is flaky today.', sentAt: ago(3), direction: 'inbound', acl: ['org:*'] },
  { externalId: 's2', source: 'slack', kind: 'message', senderName: 'Ana Silva', subject: '#partners', body: 'FYI the Northwind logo pack is in the shared drive.', sentAt: ago(20), direction: 'inbound', acl: ['org:*'] },
  { externalId: 'gh1', source: 'github', kind: 'approval', senderName: 'acme/payments-api', subject: 'PullRequest: Add idempotency keys to /charge (#432)', body: 'review requested on acme/payments-api: Add idempotency keys to /charge', sentAt: ago(110), direction: 'inbound', acl: ['org:*'] },
  { externalId: 'gh2', source: 'github', kind: 'notification', senderName: 'acme/web-app', subject: 'CheckSuite: deploy to production failed', body: 'ci activity on acme/web-app: deploy to production failed on main', sentAt: ago(2), direction: 'inbound', acl: ['org:*'] },
  { externalId: 'gh3', source: 'github', kind: 'notification', senderName: 'acme/payments-api', subject: 'Dependabot: critical vulnerability in lodash', body: 'security alert on acme/payments-api: critical vulnerability (CVE) in lodash 4.17.20', sentAt: ago(26), direction: 'inbound', acl: ['org:*'] },
  { externalId: 'jr1', source: 'jira', kind: 'notification', senderName: 'SEC-214', subject: 'SEC-214 assigned to you: Rotate leaked staging keys', body: 'Please rotate the staging keys today. Priority P1.', sentAt: ago(6), direction: 'inbound', acl: ['org:*'] },
];
await ingestMessages(client as unknown as Db, org, javed, null, messages);
// Thread for the outbound message so follow-up detection works (sent 4 days ago, no reply).
await q("UPDATE messages SET state = 'waiting' WHERE external_id = 'g7'");

const docs = [
  { externalId: 'c1', source: 'confluence', title: 'Incident Response Process', url: 'https://confluence.example/IR', body: 'Severity levels SEV1 to SEV4. The on-call engineer declares the incident, opens a Slack war room, and assigns an incident commander. Customer comms within 30 minutes for SEV1. Post-incident review within 5 business days.', acl: ['org:*'], updatedAt: ago(500) },
  { externalId: 'c2', source: 'confluence', title: 'AWS Architecture Overview v3', url: 'https://confluence.example/AWS-ARCH', body: 'Production runs in three AWS accounts (prod, staging, shared). Workloads run on ECS Fargate behind ALB. Data stores: Aurora PostgreSQL and ElastiCache. All traffic uses TLS 1.2+, secrets in AWS Secrets Manager.', acl: ['org:*'], updatedAt: ago(300) },
  { externalId: 'c3', source: 'confluence', title: 'Endpoint Security Policy', url: 'https://confluence.example/ENDPOINT', body: 'All laptops require full disk encryption, EDR agent, automatic patching within 14 days, and MFA for all corporate apps. Lost devices must be reported within 24 hours.', acl: ['org:*'], updatedAt: ago(900) },
  { externalId: 'c4', source: 'confluence', title: 'API Migration Decision Record', url: 'https://confluence.example/API-MIG', body: 'Decision: migrate the public API to v2 in Q4 using a strangler pattern. v1 stays for six months with deprecation headers. Owner: Kartik.', acl: ['org:*'], updatedAt: ago(200) },
  { externalId: 'd1', source: 'gdrive', title: 'Cleartrip Security Assessment Report (draft)', url: 'https://drive.example/cleartrip-report', body: 'Draft findings for the Cleartrip security assessment: 2 high, 5 medium. Retest planned after remediation. Report due Friday.', acl: ['org:*'], updatedAt: ago(30) },
  { externalId: 'l1', source: 'gdrive', title: 'Legal: Pending Litigation Memo (restricted)', url: 'https://drive.example/legal-memo', body: 'Privileged. Pending litigation strategy and settlement ranges. Cleartrip contract termination risk analysis.', acl: [`team:${legal}`], updatedAt: ago(40) },
];
await ingestDocuments(client as unknown as Db, org, null, docs);

const meeting = async (title: string, start: Date, mins: number, attendees: string[], agenda?: string) => {
  const id = (await q('INSERT INTO meetings (org_id, owner_user_id, external_id, title, starts_at, ends_at, provider, agenda, location_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [org, javed, `m-${title}`, title, start, new Date(start.getTime() + mins * 60_000), 'meet', agenda ?? null, 'https://meet.example/abc'])).rows[0].id as string;
  for (const a of attendees) await q('INSERT INTO meeting_participants (org_id, meeting_id, email, contact_id) VALUES ($1,$2,$3,(SELECT id FROM contacts WHERE email = $3))', [org, id, a]);
  return id;
};
const prev = await meeting('Cleartrip kickoff', at(-3, 10), 60, ['rahul@cleartrip.example', 'javed@acme.test'], 'Scope and timelines');
await q(`INSERT INTO meeting_notes (org_id, meeting_id, summary, decisions, action_items) VALUES ($1,$2,$3,$4,$5)`, [org, prev, 'Agreed scope: prod and staging AWS accounts. Retest after remediation.', JSON.stringify(['Scope limited to AWS prod and staging', 'Retest window two weeks after report']), JSON.stringify([{ title: 'Send security report', owner: 'Javed', due: 'Friday' }, { title: 'Confirm retest window', owner: 'Javed', due: 'Friday' }, { title: 'Share AWS account list', owner: 'Rahul', due: 'Monday' }])]);
await meeting('Sprint review', at(0, 14), 60, ['sam@acme.test', 'kartik@acme.test', 'javed@acme.test'], 'Demo and retro');
await meeting('Payments deploy sync', at(0, 14, 30), 30, ['kartik@acme.test', 'javed@acme.test'], 'Decide on rollback');   // overlaps on purpose
await meeting('Cleartrip retest planning', at(1, 11), 45, ['rahul@cleartrip.example', 'priya@acme.test', 'javed@acme.test'], 'Retest window and access');
await meeting('1:1 with Kartik', at(1, 15), 30, ['kartik@acme.test', 'javed@acme.test']);

const task = (title: string, status: string, due: Date | null, origin: string, source: string | null, key: string | null = null) =>
  q('INSERT INTO tasks (org_id, owner_user_id, title, status, due_at, origin, source, external_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [org, javed, title, status, due, origin, source, key]);
await task('Send security report to Cleartrip', 'open', at(3, 17), 'ai_extracted', 'gmail');
await task('Rotate leaked staging keys', 'in_progress', at(0, 17), 'jira', 'jira', 'SEC-214');
await task('Update release notes for sprint review', 'open', at(1, 12), 'ai_extracted', 'slack');
await task('Finalise endpoint hardening rollout plan', 'open', at(-2, 17), 'manual', null);
await task('Fix payments migration', 'blocked', at(1, 17), 'jira', 'jira', 'PAY-87');

await q("INSERT INTO memories (org_id, user_id, kind, key, content, expires_at) VALUES ($1,$2,'preference','writing_style','Prefers short, direct replies. Signs off with just a first name.', NULL), ($1,$2,'relationship','rahul','Rahul Mehta is the Cleartrip security lead. Escalates quickly, prefers email.', now() + interval '180 days')", [org, javed]);
await q("INSERT INTO permissions (org_id, principal, resource, effect) VALUES ($1,$2,'repo:acme/payments-api','allow')", [org, `team:${team}`]);

console.log('Seeded demo org. Sign in (DEV_AUTH=true) as javed@acme.test (owner), priya@acme.test (admin) or sam@acme.test (member).');
await client.end();
