import { z } from 'zod';
import { config } from '../config.js';
import { composeDraft, suggestReplies, local } from '../ai/index.js';
import { requireOperation } from '../integrations/registry.js';
import { loadAdapterContext, saveCredentials } from '../services/credentials.js';
import { askCompany, searchWorkspace, timeline } from '../services/search.js';
import { computeSuggestions, dailyBriefing, findFreeSlots, meetingBrief } from '../services/work.js';
import { principalsFor, type ToolContext } from './context.js';
import type { Risk } from './policy.js';
import type { Permission } from '../security/rbac.js';

/**
 * Tool registry. Agents never touch adapters, the database or credentials directly: every effect
 * goes through a tool, and every tool call goes through executor.ts (RBAC, policy, approval, audit).
 * Each tool declares its risk level here, in code, so a model cannot argue its way to a lower one.
 */
export interface ToolDef<I = any, O = any> {
  name: string;
  agent: string;
  description: string;
  risk: Risk;
  permission: Permission;
  schema: z.ZodType<I, z.ZodTypeDef, any>;
  run(ctx: ToolContext, input: I): Promise<O>;
}

const tool = <I, O>(t: ToolDef<I, O>) => t;
const CHANNELS = ['email', 'slack', 'whatsapp', 'teams'] as const;
const PROVIDER_FOR: Record<(typeof CHANNELS)[number], string> = { email: 'gmail', slack: 'slack', whatsapp: 'whatsapp', teams: 'teams' };

const messageFor = async (ctx: ToolContext, id: string) => {
  const principals = await principalsFor(ctx);
  const r = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND acl && $2::text[]', [id, principals]);
  if (!r.rows[0]) throw new Error('Message not found or not accessible');
  return r.rows[0];
};

export const tools: ToolDef[] = [
  // ------------------------------------------------------------ LOW: read / summarise / draft
  tool({
    name: 'list_inbox', agent: 'communication', risk: 'low', permission: 'inbox:read',
    description: 'List unified inbox items with filters',
    schema: z.object({
      filter: z.enum(['all', 'urgent', 'needs_reply', 'waiting', 'fyi', 'meeting', 'task', 'approval']).default('all'),
      source: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
    async run(ctx, i) {
      const p: unknown[] = [ctx.userId, await principalsFor(ctx)];
      let sql = `SELECT m.id, m.source, m.kind, m.sender_name, m.sender_address, m.subject, m.summary, m.priority, m.category, m.required_action, m.deadline, m.sent_at, m.state FROM messages m WHERE m.owner_user_id = $1 AND m.acl && $2::text[]`;
      if (i.filter === 'urgent') sql += " AND m.priority = 'urgent' AND m.state = 'open'";
      else if (i.filter === 'waiting') sql += " AND m.state = 'waiting'";
      else if (i.filter === 'all') sql += " AND m.state IN ('open','waiting')";
      else { p.push(i.filter); sql += ` AND m.category = $${p.length} AND m.state = 'open'`; }
      if (i.source) { p.push(i.source); sql += ` AND m.source = $${p.length}`; }
      p.push(i.limit);
      sql += ` ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.sent_at DESC LIMIT $${p.length}`;
      return (await ctx.db.query(sql, p)).rows;
    },
  }),
  tool({
    name: 'search_workspace', agent: 'search', risk: 'low', permission: 'inbox:read',
    description: 'Permission-aware search across all synced sources',
    schema: z.object({ query: z.string().min(1).max(300), limit: z.coerce.number().int().max(50).default(12) }),
    run: (ctx, i) => searchWorkspace(ctx, i.query, i.limit),
  }),
  tool({
    name: 'ask_company', agent: 'knowledge', risk: 'low', permission: 'inbox:read',
    description: 'Answer a question using accessible documents and messages, with sources',
    schema: z.object({ question: z.string().min(2).max(500) }),
    run: (ctx, i) => askCompany(ctx, i.question),
  }),
  tool({
    name: 'build_timeline', agent: 'search', risk: 'low', permission: 'inbox:read',
    description: 'Chronological timeline of everything about a person, project or company',
    schema: z.object({ subject: z.string().min(2).max(200) }),
    run: (ctx, i) => timeline(ctx, i.subject),
  }),
  tool({
    name: 'suggest_replies', agent: 'communication', risk: 'low', permission: 'draft:create',
    description: 'Generate reply options for a message',
    schema: z.object({ messageId: z.string().uuid() }),
    async run(ctx, i) {
      const m = await messageFor(ctx, i.messageId);
      const history = m.thread_id ? (await ctx.db.query('SELECT sender_name, body FROM messages WHERE thread_id = $1 AND id <> $2 ORDER BY sent_at DESC LIMIT 4', [m.thread_id, m.id])).rows.map((r) => `${r.sender_name ?? 'unknown'}: ${String(r.body).slice(0, 600)}`) : [];
      const style = (await ctx.db.query('SELECT preferences FROM users WHERE id = $1', [ctx.userId])).rows[0]?.preferences?.writingStyle;
      const r = await suggestReplies({ userName: ctx.userName, userStyle: style, senderName: m.sender_name, subject: m.subject, body: m.body, channel: m.source === 'gmail' ? 'email' : m.source, history });
      return { messageId: m.id, from: m.sender_name, originalSubject: m.subject, to: m.sender_address, subject: m.subject ? `Re: ${String(m.subject).replace(/^re:\s*/i, '')}` : null, channel: m.source === 'gmail' ? 'email' : m.source, ...r };
    },
  }),
  tool({
    name: 'compose_draft', agent: 'communication', risk: 'low', permission: 'draft:create',
    description: 'Write a message from a plain language instruction',
    schema: z.object({ instruction: z.string().min(3).max(1000) }),
    async run(ctx, i) {
      const knowledge = (await searchWorkspace(ctx, i.instruction, 3)).map((h) => `${h.title}: ${h.snippet}`);
      return composeDraft(i.instruction, ctx.userName, knowledge);
    },
  }),
  tool({
    name: 'extract_tasks', agent: 'task', risk: 'low', permission: 'inbox:read',
    description: 'Detect action items in a message or free text',
    schema: z.object({ messageId: z.string().uuid().optional(), text: z.string().max(20000).optional() }).refine((v) => v.messageId || v.text, 'messageId or text required'),
    async run(ctx, i) {
      const m = i.messageId ? await messageFor(ctx, i.messageId) : null;
      const text = m ? `${m.subject ?? ''}. ${m.body}` : i.text!;
      const found = local.extractTasks(text, { userName: ctx.userName.split(' ')[0] });
      return found.map((t) => ({ title: t.title, owner: t.owner, deadline: t.deadline, source: m?.source ?? 'text', sourceRef: m?.id ?? null, sentence: t.sentence }));
    },
  }),
  tool({
    name: 'daily_briefing', agent: 'workflow', risk: 'low', permission: 'inbox:read',
    description: 'Personalised daily briefing', schema: z.object({}),
    run: (ctx) => dailyBriefing(ctx),
  }),
  tool({
    name: 'list_suggestions', agent: 'workflow', risk: 'low', permission: 'inbox:read',
    description: 'Proactive suggested actions with reasons', schema: z.object({}),
    run: (ctx) => computeSuggestions(ctx),
  }),
  tool({
    name: 'list_meetings', agent: 'calendar', risk: 'low', permission: 'inbox:read',
    description: 'Meetings in a date range',
    schema: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
    async run(ctx, i) {
      return (await ctx.db.query(
        `SELECT m.*, (SELECT coalesce(json_agg(p.email), '[]') FROM meeting_participants p WHERE p.meeting_id = m.id) AS participants
         FROM meetings m WHERE owner_user_id = $1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at`, [ctx.userId, i.from, i.to])).rows;
    },
  }),
  tool({
    name: 'find_free_slots', agent: 'calendar', risk: 'low', permission: 'inbox:read',
    description: 'Suggest meeting times that avoid conflicts',
    schema: z.object({ durationMin: z.number().int().min(10).max(480).default(30), from: z.coerce.date(), to: z.coerce.date() }),
    run: (ctx, i) => findFreeSlots(ctx, i),
  }),
  tool({
    name: 'meeting_brief', agent: 'meeting', risk: 'low', permission: 'inbox:read',
    description: 'Pre-meeting brief', schema: z.object({ meetingId: z.string().uuid() }),
    run: (ctx, i) => meetingBrief(ctx, i.meetingId),
  }),
  tool({
    name: 'github_activity', agent: 'github', risk: 'low', permission: 'inbox:read',
    description: 'GitHub notifications: reviews, mentions, CI, security',
    schema: z.object({ kind: z.enum(['all', 'reviews', 'security', 'ci']).default('all'), days: z.coerce.number().int().max(60).default(7) }),
    async run(ctx, i) {
      const principals = await principalsFor(ctx);
      const filter = i.kind === 'reviews' ? "AND kind = 'approval'" : i.kind === 'security' ? "AND body ~* '(security|vulnerab|dependabot|cve)'" : i.kind === 'ci' ? "AND body ~* '(ci|workflow|build|deploy|failed)'" : '';
      return (await ctx.db.query(`SELECT id, subject, summary, priority, kind, sender_name AS repo, sent_at FROM messages WHERE owner_user_id = $1 AND source = 'github' AND acl && $2::text[] AND sent_at > now() - make_interval(days => $3) ${filter} ORDER BY sent_at DESC LIMIT 40`, [ctx.userId, principals, i.days])).rows;
    },
  }),
  tool({
    name: 'meeting_action_items', agent: 'meeting', risk: 'low', permission: 'inbox:read',
    description: 'Action items, decisions and summary from the most recent meeting notes',
    schema: z.object({ meetingId: z.string().uuid().optional() }),
    async run(ctx, i) {
      const r = await ctx.db.query(
        `SELECT m.id, m.title, m.starts_at, n.summary, n.decisions, n.action_items FROM meeting_notes n JOIN meetings m ON m.id = n.meeting_id
         WHERE m.owner_user_id = $1 AND ($2::uuid IS NULL OR m.id = $2) ORDER BY m.starts_at DESC LIMIT 1`, [ctx.userId, i.meetingId ?? null]);
      return r.rows[0] ?? null;
    },
  }),
  tool({
    name: 'list_tasks', agent: 'task', risk: 'low', permission: 'inbox:read',
    description: 'Unified task list',
    schema: z.object({ status: z.enum(['open', 'overdue', 'blocked', 'done', 'all']).default('open') }),
    async run(ctx, i) {
      const cond = i.status === 'all' ? '' : i.status === 'overdue' ? "AND status IN ('open','in_progress') AND due_at < now()" : i.status === 'open' ? "AND status IN ('open','in_progress')" : `AND status = '${i.status}'`;
      return (await ctx.db.query(`SELECT * FROM tasks WHERE owner_user_id = $1 ${cond} ORDER BY due_at NULLS LAST, created_at DESC LIMIT 100`, [ctx.userId])).rows;
    },
  }),

  // ------------------------------------------------------------ MEDIUM: create / update
  tool({
    name: 'create_task', agent: 'task', risk: 'medium', permission: 'task:write',
    description: 'Create a task (optionally from a message)',
    schema: z.object({ title: z.string().min(2).max(300), description: z.string().max(4000).optional(), dueAt: z.coerce.date().nullable().optional(), source: z.string().optional(), sourceRef: z.string().optional(), origin: z.enum(['manual', 'ai_extracted']).default('manual'), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }),
    async run(ctx, i) {
      const r = await ctx.db.query(
        `INSERT INTO tasks (org_id, owner_user_id, title, description, due_at, source, source_ref, origin, priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [ctx.orgId, ctx.userId, i.title, i.description ?? null, i.dueAt ?? null, i.source ?? null, i.sourceRef ?? null, i.origin, i.priority]);
      return r.rows[0];
    },
  }),
  tool({
    name: 'update_task', agent: 'task', risk: 'medium', permission: 'task:write',
    description: 'Change task status, due date or title',
    schema: z.object({ taskId: z.string().uuid(), status: z.enum(['open', 'in_progress', 'blocked', 'done', 'dismissed']).optional(), dueAt: z.coerce.date().nullable().optional(), title: z.string().min(2).max(300).optional() }),
    async run(ctx, i) {
      const r = await ctx.db.query(
        `UPDATE tasks SET status = coalesce($3, status), due_at = CASE WHEN $4::boolean THEN $5 ELSE due_at END, title = coalesce($6, title) WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
        [i.taskId, ctx.userId, i.status ?? null, i.dueAt !== undefined, i.dueAt ?? null, i.title ?? null]);
      if (!r.rows[0]) throw new Error('Task not found');
      return r.rows[0];
    },
  }),
  tool({
    name: 'create_meeting', agent: 'calendar', risk: 'medium', permission: 'meeting:write',
    description: 'Create a calendar event. Stored locally until a calendar integration is connected.',
    schema: z.object({ title: z.string().min(2).max(200), startsAt: z.coerce.date(), endsAt: z.coerce.date(), attendees: z.array(z.string().email()).max(50).default([]), agenda: z.string().max(4000).optional() }),
    async run(ctx, i) {
      if (i.endsAt <= i.startsAt) throw new Error('endsAt must be after startsAt');
      const clash = await ctx.db.query("SELECT title FROM meetings WHERE owner_user_id = $1 AND status <> 'cancelled' AND starts_at < $3 AND ends_at > $2", [ctx.userId, i.startsAt, i.endsAt]);
      const m = (await ctx.db.query(
        `INSERT INTO meetings (org_id, owner_user_id, external_id, title, starts_at, ends_at, agenda, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,'local') RETURNING *`,
        [ctx.orgId, ctx.userId, `local-${crypto.randomUUID()}`, i.title, i.startsAt, i.endsAt, i.agenda ?? null])).rows[0];
      for (const e of i.attendees) await ctx.db.query('INSERT INTO meeting_participants (org_id, meeting_id, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ctx.orgId, m.id, e.toLowerCase()]);
      return { meeting: m, conflicts: clash.rows.map((c) => c.title), note: 'Saved locally. Invites are sent only once a calendar integration is connected.' };
    },
  }),
  tool({
    name: 'resolve_message', agent: 'communication', risk: 'medium', permission: 'task:write',
    description: 'Mark a message done, snoozed or waiting',
    schema: z.object({ messageId: z.string().uuid(), state: z.enum(['done', 'snoozed', 'waiting', 'open']) }),
    async run(ctx, i) {
      await messageFor(ctx, i.messageId);
      await ctx.db.query('UPDATE messages SET state = $2 WHERE id = $1', [i.messageId, i.state]);
      return { ok: true };
    },
  }),
  tool({
    name: 'create_jira_ticket', agent: 'jira', risk: 'medium', permission: 'task:write',
    description: 'Create a Jira issue. Requires the Jira integration (planned).',
    schema: z.object({ project: z.string().min(2).max(20), summary: z.string().min(3).max(250), description: z.string().max(8000).default(''), priority: z.enum(['P1', 'P2', 'P3', 'P4']).default('P3') }),
    async run(ctx, i) {
      const adapter = requireOperation('jira', 'create');
      const row = (await ctx.db.query("SELECT id FROM integrations WHERE provider = 'jira' AND status = 'connected' LIMIT 1")).rows[0];
      if (!row) throw new Error('Jira is not connected');
      const a = await loadAdapterContext(ctx.db, ctx.orgId, row.id, (c) => saveCredentials(ctx.db, ctx.orgId, row.id, c));
      return adapter.create!(a, 'issue', i);
    },
  }),

  // ------------------------------------------------------------ HIGH: external side effects
  tool({
    name: 'send_message', agent: 'communication', risk: 'high', permission: 'message:send',
    description: 'Send an email, Slack, Teams or WhatsApp message',
    schema: z.object({ channel: z.enum(CHANNELS), to: z.array(z.string().min(1)).min(1).max(50), subject: z.string().max(300).optional(), body: z.string().min(1).max(20000), inReplyTo: z.string().uuid().optional() }),
    async run(ctx, i) {
      const provider = PROVIDER_FOR[i.channel];
      const adapter = requireOperation(provider, 'send');
      const integ = (await ctx.db.query("SELECT id FROM integrations WHERE provider = $1 AND status = 'connected' AND (user_id = $2 OR user_id IS NULL) LIMIT 1", [provider, ctx.userId])).rows[0];
      let externalId: string; let simulated = false;
      let threadExternalId: string | undefined;
      if (i.inReplyTo) threadExternalId = (await ctx.db.query('SELECT t.external_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $1', [i.inReplyTo])).rows[0]?.external_id;
      if (integ) {
        const a = await loadAdapterContext(ctx.db, ctx.orgId, integ.id, (c) => saveCredentials(ctx.db, ctx.orgId, integ.id, c));
        externalId = (await adapter.send!(a, { to: i.to, subject: i.subject, body: i.body, threadExternalId, channel: i.channel })).externalId;
      } else if (config.DEV_AUTH === 'true') {
        externalId = `simulated-${crypto.randomUUID()}`; simulated = true;       // local demo only, nothing leaves the machine
      } else throw new Error(`${provider} is not connected`);
      await ctx.db.query(
        `INSERT INTO messages (org_id, owner_user_id, source, kind, external_id, sender_name, subject, body, sent_at, direction, state, acl) VALUES ($1,$2,$3,'message',$4,$5,$6,$7,now(),'outbound','waiting',$8)`,
        [ctx.orgId, ctx.userId, provider, externalId, i.to.join(', '), i.subject ?? null, i.body, [`user:${ctx.userId}`]]);
      if (i.inReplyTo) await ctx.db.query("UPDATE messages SET state = 'done' WHERE id = $1", [i.inReplyTo]);
      return { sent: !simulated, simulated, externalId };
    },
  }),
  tool({
    name: 'forget_memory', agent: 'supervisor', risk: 'high', permission: 'inbox:read',
    description: 'Permanently delete stored memory items',
    schema: z.object({ kind: z.enum(['conversation', 'preference', 'company', 'project', 'relationship', 'task_history', 'all']) }),
    async run(ctx, i) {
      const r = await ctx.db.query(`DELETE FROM memories WHERE user_id = $1 AND ($2 = 'all' OR kind = $2)`, [ctx.userId, i.kind]);
      return { deleted: r.rowCount };
    },
  }),
];

export const toolByName = new Map(tools.map((t) => [t.name, t]));
