import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { rawQuery, withOrg } from '../db.js';
import type { ToolContext } from '../agents/context.js';
import { decideApproval, executeTool, type ExecResult } from '../agents/executor.js';
import { listAgents, integrationCatalog } from '../agents/registry.js';
import { runCommand } from '../agents/supervisor.js';
import { aiMode } from '../ai/index.js';
import { requireOperation } from '../integrations/registry.js';
import { getAdapter } from '../integrations/registry.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { HttpError, assertCan, type Role } from '../security/rbac.js';
import { saveCredentials } from '../services/credentials.js';
import { startOAuth } from '../services/oauth.js';
import { syncIntegration } from '../services/sync.js';
import { verifyChain } from '../audit.js';
import { toolByName } from '../agents/tools.js';

interface Auth { sessionId: string; orgId: string; userId: string; role: Role; email: string; name: string; mfa: boolean }
declare module 'fastify' { interface FastifyRequest { auth?: Auth } }

const COOKIE = 'awh_session';
const CLIENTS: Record<string, () => string | undefined> = { gmail: () => config.GOOGLE_CLIENT_ID, github: () => config.GITHUB_CLIENT_ID };
const SECRETS: Record<string, () => string | undefined> = { gmail: () => config.GOOGLE_CLIENT_SECRET, github: () => config.GITHUB_CLIENT_SECRET };

export async function routes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ auth plumbing
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/health') || req.url.startsWith('/auth/dev-login')) return;
    // CSRF: cookie auth + state changing method requires our header and a matching Origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.url.includes('/callback')) {
      if (req.headers['x-requested-with'] !== 'awh') throw new HttpError(403, 'Missing CSRF header');
      const origin = req.headers.origin;
      if (origin && origin !== config.WEB_ORIGIN) throw new HttpError(403, 'Bad origin');
    }
    const token = req.cookies[COOKIE];
    if (!token) throw new HttpError(401, 'Not signed in');
    const r = await rawQuery<{ session_id: string; org_id: string; user_id: string; role: Role; email: string; display_name: string; mfa_passed: boolean }>('SELECT * FROM auth_lookup_session($1)', [sha256(token)]);
    const s = r.rows[0];
    if (!s) { reply.clearCookie(COOKIE, { path: '/' }); throw new HttpError(401, 'Session expired'); }
    req.auth = { sessionId: s.session_id, orgId: s.org_id, userId: s.user_id, role: s.role, email: s.email, name: s.display_name, mfa: s.mfa_passed };
  });

  const ctxFor = (req: FastifyRequest, db: Db): ToolContext => {
    const a = req.auth!;
    return { db, orgId: a.orgId, userId: a.userId, userName: a.name, userEmail: a.email, role: a.role, ip: req.ip, origin: 'user' };
  };
  const scoped = <T>(req: FastifyRequest, fn: (ctx: ToolContext) => Promise<T>) => withOrg(req.auth!.orgId, (db) => fn(ctxFor(req, db)));
  const run = (req: FastifyRequest, agent: string, tool: string, input: unknown) => scoped(req, (ctx) => executeTool(ctx, agent, tool, input));
  /** Read tools return their output directly; anything that needs approval returns 202 with the request. */
  const respond = (reply: FastifyReply, r: ExecResult) => {
    if (r.status === 'executed') return r.output;
    if (r.status === 'pending_approval') return reply.code(202).send(r);
    if (r.status === 'denied') return reply.code(403).send(r);
    return reply.code(422).send(r);
  };
  /** Admin routes: RBAC, plus MFA when the organisation requires it. */
  const admin = async (req: FastifyRequest, perm: Parameters<typeof assertCan>[1]) => {
    assertCan(req.auth!.role, perm);
    const org = await withOrg(req.auth!.orgId, async (db) => (await db.query('SELECT settings FROM organisations WHERE id = $1', [req.auth!.orgId])).rows[0]);
    if (org?.settings?.requireMfa && !req.auth!.mfa) throw new HttpError(403, 'MFA required for admin actions');
  };

  // ------------------------------------------------------------ health & session
  app.get('/health', async () => ({ ok: true, ai: aiMode() }));

  app.post('/auth/dev-login', async (req, reply) => {
    if (config.DEV_AUTH !== 'true') throw new HttpError(404, 'Not found');
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const u = (await rawQuery<{ user_id: string; org_id: string }>('SELECT * FROM auth_find_user($1)', [email])).rows[0];
    if (!u) throw new HttpError(401, 'Unknown user');
    const token = randomToken();
    await withOrg(u.org_id, async (db) => {
      await db.query('INSERT INTO sessions (org_id, user_id, token_hash, user_agent, ip, expires_at, mfa_passed) VALUES ($1,$2,$3,$4,$5,$6,true)', [u.org_id, u.user_id, sha256(token), req.headers['user-agent'] ?? null, req.ip, new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000)]);
      await audit(db, { orgId: u.org_id, actorUserId: u.user_id, event: 'session.created', detail: { method: 'dev-login' }, ip: req.ip });
    });
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    await withOrg(req.auth!.orgId, async (db) => {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth!.sessionId]);
      await audit(db, { orgId: req.auth!.orgId, actorUserId: req.auth!.userId, event: 'session.revoked', ip: req.ip });
    });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => ({ ...req.auth, aiMode: aiMode() }));

  // ------------------------------------------------------------ inbox & drafting
  app.get('/inbox', async (req, reply) => respond(reply, await run(req, 'communication', 'list_inbox', req.query)));
  app.get('/messages/:id', async (req) => scoped(req, async (ctx) => {
    const { id } = req.params as { id: string };
    const r = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND owner_user_id = $2', [id, ctx.userId]);
    if (!r.rows[0]) throw new HttpError(404, 'Not found');
    const thread = r.rows[0].thread_id ? (await ctx.db.query('SELECT id, sender_name, body, sent_at, direction FROM messages WHERE thread_id = $1 ORDER BY sent_at', [r.rows[0].thread_id])).rows : [];
    return { message: r.rows[0], thread };
  }));
  app.post('/messages/:id/replies', async (req, reply) => respond(reply, await run(req, 'communication', 'suggest_replies', { messageId: (req.params as { id: string }).id })));
  app.post('/messages/:id/resolve', async (req, reply) => respond(reply, await run(req, 'communication', 'resolve_message', { messageId: (req.params as { id: string }).id, state: (req.body as { state?: string })?.state })));
  app.post('/messages/:id/tasks/extract', async (req, reply) => respond(reply, await run(req, 'task', 'extract_tasks', { messageId: (req.params as { id: string }).id })));
  app.post('/compose', async (req, reply) => respond(reply, await run(req, 'communication', 'compose_draft', req.body)));
  app.post('/send', async (req, reply) => respond(reply, await run(req, 'communication', 'send_message', req.body)));

  // ------------------------------------------------------------ tasks, meetings, briefing
  app.get('/tasks', async (req, reply) => respond(reply, await run(req, 'task', 'list_tasks', req.query)));
  app.post('/tasks', async (req, reply) => respond(reply, await run(req, 'task', 'create_task', req.body)));
  app.patch('/tasks/:id', async (req, reply) => respond(reply, await run(req, 'task', 'update_task', { ...(req.body as object), taskId: (req.params as { id: string }).id })));
  app.get('/meetings', async (req, reply) => respond(reply, await run(req, 'calendar', 'list_meetings', req.query)));
  app.post('/meetings', async (req, reply) => respond(reply, await run(req, 'calendar', 'create_meeting', req.body)));
  app.post('/meetings/free-slots', async (req, reply) => respond(reply, await run(req, 'calendar', 'find_free_slots', req.body)));
  app.get('/meetings/:id/brief', async (req, reply) => respond(reply, await run(req, 'meeting', 'meeting_brief', { meetingId: (req.params as { id: string }).id })));
  app.get('/meetings/:id/notes', async (req, reply) => respond(reply, await run(req, 'meeting', 'meeting_action_items', { meetingId: (req.params as { id: string }).id })));
  app.get('/briefing', async (req, reply) => respond(reply, await run(req, 'workflow', 'daily_briefing', {})));
  app.get('/suggestions', async (req, reply) => respond(reply, await run(req, 'workflow', 'list_suggestions', {})));
  app.get('/github/activity', async (req, reply) => respond(reply, await run(req, 'github', 'github_activity', req.query)));

  // ------------------------------------------------------------ search & command bar
  app.post('/search', async (req, reply) => respond(reply, await run(req, 'search', 'search_workspace', req.body)));
  app.post('/ask', async (req, reply) => respond(reply, await run(req, 'knowledge', 'ask_company', req.body)));
  app.get('/timeline', async (req, reply) => respond(reply, await run(req, 'search', 'build_timeline', req.query)));
  app.post('/command', async (req) => {
    const { text } = z.object({ text: z.string().min(2).max(1000) }).parse(req.body);
    return scoped(req, (ctx) => runCommand(ctx, text));
  });
  app.get('/agents', async () => ({ agents: listAgents(), tools: [...toolByName.values()].map((t) => ({ name: t.name, agent: t.agent, risk: t.risk, description: t.description })) }));

  // ------------------------------------------------------------ approvals
  app.get('/approvals', async (req) => scoped(req, async (ctx) => {
    const status = (req.query as { status?: string }).status ?? 'pending';
    const admin = ctx.role === 'admin' || ctx.role === 'owner';
    return (await ctx.db.query(
      `SELECT id, user_id, tool, risk, preview, approver_role, status, expires_at, created_at FROM approval_requests
       WHERE status = $1 AND (user_id = $2 OR ($3::boolean AND approver_role = 'admin')) ORDER BY created_at DESC LIMIT 100`, [status, ctx.userId, admin])).rows;
  }));
  const decide = (action: 'approve' | 'reject') => async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const edited = (req.body as { input?: unknown } | undefined)?.input;
    return withOrg(req.auth!.orgId, (db) => decideApproval({ db, orgId: req.auth!.orgId, ip: req.ip }, { userId: req.auth!.userId, role: req.auth!.role, ip: req.ip }, id, action, edited));
  };
  app.post('/approvals/:id/approve', decide('approve'));
  app.post('/approvals/:id/reject', decide('reject'));

  // ------------------------------------------------------------ integrations
  app.get('/integrations', async (req) => scoped(req, async (ctx) => {
    const connected = (await ctx.db.query('SELECT id, provider, status, external_account, scopes, last_error, user_id FROM integrations')).rows;
    return { catalog: integrationCatalog().map((c) => ({ ...c, configured: Boolean(CLIENTS[c.provider]?.() && SECRETS[c.provider]?.()), connections: connected.filter((x) => x.provider === c.provider) })) };
  }));

  /** Starts OAuth 2.0 + PKCE. State and verifier travel in a signed, short lived, httpOnly cookie. */
  app.get('/integrations/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const adapter = getAdapter(provider);
    if (!adapter?.oauth || adapter.status !== 'ready') throw new HttpError(400, `${provider} cannot be connected yet`);
    const clientId = CLIENTS[provider]?.();
    if (!clientId) throw new HttpError(400, `Set the ${provider} OAuth client id and secret in the API environment first`);
    const o = startOAuth(provider, adapter.oauth, clientId);
    reply.setCookie('awh_oauth', JSON.stringify({ state: o.state, verifier: o.verifier, provider }), { signed: true, httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', path: '/', maxAge: 600 });
    return { url: o.url };
  });

  app.get('/integrations/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = z.object({ code: z.string(), state: z.string() }).parse(req.query);
    const raw = req.cookies.awh_oauth ? req.unsignCookie(req.cookies.awh_oauth) : null;
    if (!raw?.valid || !raw.value) throw new HttpError(400, 'OAuth session expired');
    const saved = JSON.parse(raw.value) as { state: string; verifier: string; provider: string };
    if (saved.provider !== provider || saved.state !== q.state) throw new HttpError(400, 'OAuth state mismatch');
    reply.clearCookie('awh_oauth', { path: '/' });
    const adapter = requireOperation(provider, 'connect');
    const redirectUri = `${config.API_PUBLIC_URL}/integrations/${provider}/callback`;
    const out = await adapter.connect!({ code: q.code, redirectUri, codeVerifier: saved.verifier });
    await withOrg(req.auth!.orgId, async (db) => {
      const i = await db.query(
        `INSERT INTO integrations (org_id, user_id, provider, status, scopes, external_account) VALUES ($1,$2,$3,'connected',$4,$5)
         ON CONFLICT (org_id, user_id, provider) DO UPDATE SET status='connected', scopes=$4, external_account=$5, last_error=NULL RETURNING id`,
        [req.auth!.orgId, req.auth!.userId, provider, out.scopes, out.externalAccount]);
      await saveCredentials(db, req.auth!.orgId, i.rows[0].id, out.credentials);
      await audit(db, { orgId: req.auth!.orgId, actorUserId: req.auth!.userId, event: 'integration.connected', target: provider, detail: { account: out.externalAccount, scopes: out.scopes }, ip: req.ip });
    });
    return reply.redirect(`${config.WEB_ORIGIN}/integrations?connected=${provider}`);
  });

  app.post('/integrations/:id/sync', async (req) => {
    const { id } = req.params as { id: string };
    return syncIntegration(req.auth!.orgId, req.auth!.userId, id);
  });

  app.delete('/integrations/:id', async (req) => {
    const { id } = req.params as { id: string };
    return scoped(req, async (ctx) => {
      const i = (await ctx.db.query('SELECT provider, user_id FROM integrations WHERE id = $1', [id])).rows[0];
      if (!i) throw new HttpError(404, 'Not found');
      if (i.user_id !== ctx.userId) assertCan(ctx.role, 'integration:manage');
      await ctx.db.query("UPDATE integrations SET status = 'revoked' WHERE id = $1", [id]);
      await ctx.db.query('DELETE FROM oauth_credentials WHERE integration_id = $1', [id]);   // tokens are destroyed, not archived
      await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, event: 'integration.revoked', target: i.provider, ip: ctx.ip });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ memory (user visible and deletable)
  app.get('/memory', async (req) => scoped(req, async (ctx) => (await ctx.db.query('SELECT id, kind, key, content, source_ref, expires_at, created_at FROM memories WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 200', [ctx.userId])).rows));
  app.delete('/memory/:id', async (req) => scoped(req, async (ctx) => {
    const r = await ctx.db.query('DELETE FROM memories WHERE id = $1 AND user_id = $2', [(req.params as { id: string }).id, ctx.userId]);
    await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, event: 'memory.deleted', target: (req.params as { id: string }).id, ip: ctx.ip });
    return { deleted: r.rowCount };
  }));
  app.delete('/memory', async (req, reply) => respond(reply, await run(req, 'supervisor', 'forget_memory', { kind: (req.query as { kind?: string }).kind ?? 'all' })));

  // ------------------------------------------------------------ automations (preview before activation)
  const Steps = z.array(z.object({ tool: z.string(), input: z.record(z.unknown()).default({}) })).min(1).max(10);
  const describe = (steps: z.infer<typeof Steps>, autoSend: boolean) => steps.map((s, n) => {
    const t = toolByName.get(s.tool);
    if (!t) throw new HttpError(400, `Unknown tool ${s.tool}`);
    return { step: n + 1, tool: t.name, agent: t.agent, risk: t.risk, description: t.description, input: s.input, runsWithoutApproval: t.risk !== 'high' || autoSend };
  });
  app.post('/automations/preview', async (req) => {
    const b = z.object({ steps: Steps, autoSend: z.boolean().default(false) }).parse(req.body);
    return { actions: describe(b.steps, b.autoSend) };
  });
  app.get('/automations', async (req) => scoped(req, async (ctx) => (await ctx.db.query('SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC', [ctx.userId])).rows));
  app.post('/automations', async (req) => {
    const b = z.object({ name: z.string().min(2).max(120), trigger: z.record(z.unknown()), steps: Steps, autoSend: z.boolean().default(false) }).parse(req.body);
    const actions = describe(b.steps, b.autoSend);
    return scoped(req, async (ctx) => {
      const r = await ctx.db.query('INSERT INTO automations (org_id, user_id, name, trigger, steps, auto_send, enabled) VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *', [ctx.orgId, ctx.userId, b.name, JSON.stringify(b.trigger), JSON.stringify(b.steps), b.autoSend]);
      await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, event: 'automation.created', target: b.name, detail: { actions: actions.length, autoSend: b.autoSend }, ip: ctx.ip });
      return { automation: r.rows[0], actions, note: 'Created disabled. Review the actions above, then enable it.' };
    });
  });
  app.post('/automations/:id/enable', async (req) => scoped(req, async (ctx) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = await ctx.db.query('UPDATE automations SET enabled = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name, enabled', [(req.params as { id: string }).id, ctx.userId, enabled]);
    if (!r.rows[0]) throw new HttpError(404, 'Not found');
    await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, event: enabled ? 'automation.enabled' : 'automation.disabled', target: r.rows[0].name, ip: ctx.ip });
    return r.rows[0];
  }));

  // ------------------------------------------------------------ admin
  app.get('/admin/audit', async (req) => {
    await admin(req, 'audit:read');
    const { limit = '100', event } = req.query as { limit?: string; event?: string };
    return scoped(req, async (ctx) => (await ctx.db.query('SELECT id, actor_user_id, actor_kind, event, target, detail, ip, created_at FROM audit_logs WHERE ($2::text IS NULL OR event LIKE $2 || \'%\') ORDER BY id DESC LIMIT $1', [Math.min(Number(limit) || 100, 500), event ?? null])).rows);
  });
  app.get('/admin/audit/verify', async (req) => {
    await admin(req, 'audit:read');
    return scoped(req, async (ctx) => {
      const rows = (await ctx.db.query('SELECT * FROM audit_logs ORDER BY id ASC')).rows;
      const broken = verifyChain(rows);
      return { ok: broken === null, checked: rows.length, firstBrokenId: broken };
    });
  });
  app.get('/admin/actions', async (req) => {
    await admin(req, 'audit:read');
    return scoped(req, async (ctx) => (await ctx.db.query('SELECT a.*, u.email FROM agent_actions a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200')).rows);
  });
  app.get('/admin/policies', async (req) => {
    await admin(req, 'policy:manage');
    return scoped(req, async (ctx) => (await ctx.db.query('SELECT action, risk, mode, approver_role FROM approval_policies ORDER BY action')).rows);
  });
  app.put('/admin/policies', async (req) => {
    await admin(req, 'policy:manage');
    const b = z.object({ action: z.string().min(1), risk: z.enum(['low', 'medium', 'high']).nullable().default(null), mode: z.enum(['allow', 'require_approval', 'deny']), approverRole: z.enum(['self', 'admin']).default('self') }).parse(req.body);
    if (b.action !== '*' && !toolByName.has(b.action)) throw new HttpError(400, 'Unknown tool');
    if (b.action === '*' && !b.risk) throw new HttpError(400, 'Class policies need a risk level');
    return scoped(req, async (ctx) => {
      await ctx.db.query(`INSERT INTO approval_policies (org_id, action, risk, mode, approver_role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, action) DO UPDATE SET risk = $3, mode = $4, approver_role = $5`, [ctx.orgId, b.action === '*' ? '*' : b.action, b.risk, b.mode, b.approverRole]);
      await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: 'admin', event: 'policy.updated', target: b.action, detail: b, ip: ctx.ip });
      return { ok: true };
    });
  });
  app.get('/admin/users', async (req) => {
    await admin(req, 'user:manage');
    return scoped(req, async (ctx) => (await ctx.db.query('SELECT id, email, display_name, role, mfa_enrolled, disabled_at, created_at FROM users ORDER BY created_at')).rows);
  });
  app.patch('/admin/users/:id', async (req) => {
    await admin(req, 'user:manage');
    const b = z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(), disabled: z.boolean().optional() }).parse(req.body);
    const id = (req.params as { id: string }).id;
    if (b.role === 'owner' && req.auth!.role !== 'owner') throw new HttpError(403, 'Only an owner can grant owner');
    return scoped(req, async (ctx) => {
      const r = await ctx.db.query('UPDATE users SET role = coalesce($2, role), disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN now() ELSE NULL END WHERE id = $1 RETURNING id, email, role, disabled_at', [id, b.role ?? null, b.disabled ?? null]);
      if (!r.rows[0]) throw new HttpError(404, 'Not found');
      if (b.disabled) await ctx.db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);   // revoke access immediately
      await audit(ctx.db, { orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: 'admin', event: 'user.updated', target: r.rows[0].email, detail: b, ip: ctx.ip });
      return r.rows[0];
    });
  });
  app.get('/admin/integrations', async (req) => {
    await admin(req, 'integration:manage');
    return scoped(req, async (ctx) => (await ctx.db.query('SELECT i.id, i.provider, i.status, i.external_account, i.last_error, u.email AS user_email FROM integrations i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.provider')).rows);
  });
}
