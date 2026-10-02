import { audit } from '../audit.js';
import type { Db } from '../db.js';
import { HttpError, assertCan, type Role } from '../security/rbac.js';
import { sha256 } from '../security/crypto.js';
import type { ToolContext } from './context.js';
import { decide, type PolicyRow } from './policy.js';
import { toolByName } from './tools.js';

export type ExecResult =
  | { status: 'executed'; tool: string; output: unknown; actionId: string }
  | { status: 'pending_approval'; tool: string; approvalId: string; risk: string; preview: unknown; reason: string }
  | { status: 'denied'; tool: string; reason: string }
  | { status: 'failed'; tool: string; error: string };

const APPROVAL_TTL_MS = 24 * 3_600_000;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export const payloadHash = (tool: string, input: unknown) => sha256(canonical({ tool, input }));

async function policies(db: Db): Promise<PolicyRow[]> {
  return (await db.query('SELECT action, risk, mode, approver_role FROM approval_policies')).rows;
}

async function recordAction(ctx: ToolContext, agent: string, tool: string, risk: string, input: unknown, status: string, output?: unknown): Promise<string> {
  const r = await ctx.db.query(
    'INSERT INTO agent_actions (org_id, user_id, agent, tool, risk, input, output, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [ctx.orgId, ctx.userId, agent, tool, risk, JSON.stringify(input), output === undefined ? null : JSON.stringify(output), status]);
  return r.rows[0].id;
}

/** Runs a tool body inside a savepoint so a failure is recorded without aborting the request transaction. */
async function runGuarded(ctx: ToolContext, agent: string, name: string, input: unknown, approvedBy?: string): Promise<ExecResult> {
  const t = toolByName.get(name)!;
  await ctx.db.query('SAVEPOINT tool_run');
  try {
    const output = await t.run(ctx, input);
    await ctx.db.query('RELEASE SAVEPOINT tool_run');
    const actionId = await recordAction(ctx, agent, name, t.risk, input, 'executed', summariseOutput(output));
    await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: 'agent', event: 'tool.executed', target: name, detail: { agent, risk: t.risk, approvedBy: approvedBy ?? null, origin: ctx.origin }, ip: ctx.ip });
    return { status: 'executed', tool: name, output, actionId };
  } catch (err) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT tool_run');
    const error = err instanceof Error ? err.message : String(err);
    await recordAction(ctx, agent, name, t.risk, input, 'failed', { error });
    await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: 'agent', event: 'tool.failed', target: name, detail: { agent, error }, ip: ctx.ip });
    return { status: 'failed', tool: name, error };
  }
}

/** Keep large outputs (message lists, briefs) out of the action log. */
const summariseOutput = (o: unknown) => (JSON.stringify(o ?? null).length > 4000 ? { truncated: true } : o);

/**
 * The only way anything runs. Order: validate input, RBAC, org policy, then either run, park for
 * approval, or deny. Agents and routes both call this; neither can reach a tool body directly.
 */
export async function executeTool(ctx: ToolContext, agent: string, name: string, rawInput: unknown): Promise<ExecResult> {
  const t = toolByName.get(name);
  if (!t) throw new HttpError(404, `Unknown tool ${name}`);
  const parsed = t.schema.safeParse(rawInput ?? {});
  if (!parsed.success) throw new HttpError(400, `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  assertCan(ctx.role, t.permission);

  const decision = decide({ tool: name, risk: t.risk, policies: await policies(ctx.db), automationAutoRun: ctx.origin === 'automation' && ctx.automationAutoRun });

  if (decision.mode === 'deny') {
    await recordAction(ctx, agent, name, t.risk, parsed.data, 'denied');
    await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: 'agent', event: 'tool.denied', target: name, detail: { reason: decision.reason }, ip: ctx.ip });
    return { status: 'denied', tool: name, reason: decision.reason };
  }

  if (decision.mode === 'require_approval') {
    const actionId = await recordAction(ctx, agent, name, t.risk, parsed.data, 'pending_approval');
    const preview = { tool: name, description: t.description, input: parsed.data };
    const r = await ctx.db.query(
      `INSERT INTO approval_requests (org_id, user_id, action_id, tool, risk, preview, payload_hash, approver_role, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.orgId, ctx.userId, actionId, name, t.risk, JSON.stringify(preview), payloadHash(name, parsed.data), decision.approverRole, new Date(Date.now() + APPROVAL_TTL_MS)]);
    await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: 'agent', event: 'approval.requested', target: name, detail: { approvalId: r.rows[0].id, reason: decision.reason }, ip: ctx.ip });
    return { status: 'pending_approval', tool: name, approvalId: r.rows[0].id, risk: t.risk, preview, reason: decision.reason };
  }

  return runGuarded(ctx, agent, name, parsed.data);
}

export interface Decider { userId: string; role: Role; ip?: string }

/**
 * Approve (optionally with an edited payload, which re-hashes) or reject. The tool runs as the
 * requesting user with that user's current role, so approving never grants extra privilege.
 */
export async function decideApproval(base: Omit<ToolContext, 'userId' | 'userName' | 'userEmail' | 'role' | 'origin'>, decider: Decider, approvalId: string, action: 'approve' | 'reject', editedInput?: unknown): Promise<ExecResult | { status: 'rejected' }> {
  const { db, orgId } = base;
  const row = (await db.query('SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE', [approvalId])).rows[0];
  if (!row) throw new HttpError(404, 'Approval request not found');
  if (row.status !== 'pending') throw new HttpError(409, `Request is already ${row.status}`);
  if (new Date(row.expires_at) < new Date()) {
    await db.query("UPDATE approval_requests SET status = 'expired' WHERE id = $1", [approvalId]);
    throw new HttpError(410, 'Approval request expired');
  }
  const isRequester = row.user_id === decider.userId;
  const isAdmin = decider.role === 'admin' || decider.role === 'owner';
  if (row.approver_role === 'admin') {
    if (!isAdmin) throw new HttpError(403, 'An admin must approve this action');
    if (isRequester) throw new HttpError(403, 'Four-eyes rule: you cannot approve your own request');
  } else if (!isRequester) {
    throw new HttpError(403, 'Only the requester can approve this action');
  }

  if (action === 'reject') {
    await db.query("UPDATE approval_requests SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1", [approvalId, decider.userId]);
    await db.query("UPDATE agent_actions SET status = 'cancelled' WHERE id = $1", [row.action_id]);
    await audit(db, { orgId, actorUserId: decider.userId, actorKind: 'user', event: 'approval.rejected', target: row.tool, detail: { approvalId }, ip: decider.ip });
    return { status: 'rejected' };
  }

  const t = toolByName.get(row.tool);
  if (!t) throw new HttpError(404, 'Tool no longer exists');
  let input = row.preview.input;
  if (editedInput !== undefined) {
    const p = t.schema.safeParse(editedInput);
    if (!p.success) throw new HttpError(400, 'Edited payload is invalid');
    input = p.data;
    await db.query('UPDATE approval_requests SET preview = $2, payload_hash = $3 WHERE id = $1', [approvalId, JSON.stringify({ ...row.preview, input }), payloadHash(row.tool, input)]);
    await audit(db, { orgId, actorUserId: decider.userId, actorKind: 'user', event: 'approval.edited', target: row.tool, detail: { approvalId, previousHash: row.payload_hash }, ip: decider.ip });
  } else if (payloadHash(row.tool, input) !== row.payload_hash) {
    throw new HttpError(409, 'Payload changed after the approval was requested');
  }

  const requester = (await db.query('SELECT id, display_name, email, role FROM users WHERE id = $1 AND disabled_at IS NULL', [row.user_id])).rows[0];
  if (!requester) throw new HttpError(409, 'Requesting user is no longer active');
  assertCan(requester.role, t.permission);
  const ctx: ToolContext = { ...base, userId: requester.id, userName: requester.display_name, userEmail: requester.email, role: requester.role, origin: 'user', ip: decider.ip };

  await db.query("UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1", [approvalId, decider.userId]);
  await audit(db, { orgId, actorUserId: decider.userId, actorKind: 'user', event: 'approval.approved', target: row.tool, detail: { approvalId }, ip: decider.ip });
  const result = await runGuarded(ctx, t.agent, row.tool, input, decider.userId);
  await db.query("UPDATE approval_requests SET status = $2 WHERE id = $1", [approvalId, result.status === 'executed' ? 'executed' : 'approved']);
  await db.query('UPDATE agent_actions SET status = $2 WHERE id = $1', [row.action_id, result.status === 'executed' ? 'executed' : 'failed']);
  return result;
}
