import type { ToolContext } from '../agents/context.js';
import { principalsFor } from '../agents/context.js';
import { local } from '../ai/index.js';

const DAY = 86_400_000;

// ------------------------------------------------------------------ calendar
export interface Slot { start: string; end: string }

/** Free slots inside working hours (UTC), skipping existing meetings. */
export async function findFreeSlots(ctx: ToolContext, o: { durationMin: number; from: Date; to: Date; workStartHour?: number; workEndHour?: number; max?: number }): Promise<Slot[]> {
  const { durationMin, from, to, workStartHour = 9, workEndHour = 18, max = 8 } = o;
  const busy = await ctx.db.query<{ starts_at: Date; ends_at: Date }>(
    "SELECT starts_at, ends_at FROM meetings WHERE owner_user_id = $1 AND status <> 'cancelled' AND ends_at > $2 AND starts_at < $3 ORDER BY starts_at", [ctx.userId, from, to]);
  const slots: Slot[] = [];
  const step = 30 * 60_000;
  const need = durationMin * 60_000;
  for (let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); day < to.getTime() && slots.length < max; day += DAY) {
    const dow = new Date(day).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let t = day + workStartHour * 3_600_000; t + need <= day + workEndHour * 3_600_000 && slots.length < max; t += step) {
      if (t < from.getTime() || t + need > to.getTime()) continue;
      const clash = busy.rows.some((b) => b.starts_at.getTime() < t + need && b.ends_at.getTime() > t);
      if (!clash) {
        slots.push({ start: new Date(t).toISOString(), end: new Date(t + need).toISOString() });
        t += need - step; // do not offer overlapping candidates
      }
    }
  }
  return slots;
}

export function overlaps(ms: { id: string; title: string; starts_at: Date; ends_at: Date }[]) {
  const sorted = [...ms].sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());
  const out: { a: string; b: string; at: Date }[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    if (sorted[j]!.starts_at < sorted[i]!.ends_at) out.push({ a: sorted[i]!.title, b: sorted[j]!.title, at: sorted[j]!.starts_at });
    else break;
  }
  return out;
}

export async function meetingBrief(ctx: ToolContext, meetingId: string) {
  const m = (await ctx.db.query('SELECT * FROM meetings WHERE id = $1 AND owner_user_id = $2', [meetingId, ctx.userId])).rows[0];
  if (!m) return null;
  const principals = await principalsFor(ctx);
  const people = (await ctx.db.query(
    `SELECT p.email, p.response, c.name, c.company FROM meeting_participants p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.meeting_id = $1`, [meetingId])).rows;
  const emails = people.map((p) => String(p.email).toLowerCase()).filter((e) => e !== ctx.userEmail.toLowerCase());
  const keyword = String(m.title).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3 && !/^(sync|meeting|call|review|weekly|standup|with)$/i.test(w)).join(' or ') || 'meeting';
  const [msgs, tasks, notes, related] = await Promise.all([
    ctx.db.query(
      `SELECT id, source, subject, summary, sent_at, sender_name, priority FROM messages
       WHERE acl && $2::text[] AND (lower(sender_address) = ANY($1) OR search_tsv @@ websearch_to_tsquery('english', $3))
       ORDER BY sent_at DESC LIMIT 8`, [emails, principals, keyword]),
    ctx.db.query(
      `SELECT id, title, status, due_at, origin, external_key FROM tasks
       WHERE owner_user_id = $1 AND status IN ('open','in_progress','blocked') AND (title ILIKE ANY($2) OR description ILIKE ANY($2)) ORDER BY due_at NULLS LAST LIMIT 8`,
      [ctx.userId, [`%${String(m.title).split(/\s+/)[0]}%`, ...emails.map((e) => `%${e.split('@')[0]}%`)]]),
    ctx.db.query(
      `SELECT n.summary, n.decisions, n.action_items, mt.title, mt.starts_at FROM meeting_notes n JOIN meetings mt ON mt.id = n.meeting_id
       WHERE mt.owner_user_id = $1 AND mt.id <> $2 AND mt.starts_at < now() AND EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = mt.id AND lower(p.email) = ANY($3))
       ORDER BY mt.starts_at DESC LIMIT 3`, [ctx.userId, meetingId, emails]),
    ctx.db.query(
      `SELECT id, source, title, url FROM documents WHERE acl && $2::text[] AND search_tsv @@ websearch_to_tsquery('english', $1) LIMIT 5`, [String(m.title), principals]),
  ]);
  const talking: string[] = [];
  for (const t of tasks.rows.filter((t) => t.status === 'blocked')) talking.push(`Unblock: ${t.title}`);
  for (const t of tasks.rows.filter((t) => t.status !== 'blocked').slice(0, 3)) talking.push(`Status check: ${t.title}${t.due_at ? ` (due ${new Date(t.due_at).toISOString().slice(0, 10)})` : ''}`);
  for (const x of msgs.rows.filter((x) => x.priority === 'urgent' || x.priority === 'high').slice(0, 2)) talking.push(`Open thread: ${x.subject ?? x.summary}`);
  if (!talking.length) talking.push('Confirm goals and decisions needed for this meeting');
  return { meeting: m, participants: people, recentConversations: msgs.rows, openTasks: tasks.rows, previousNotes: notes.rows, documents: related.rows, talkingPoints: talking };
}

// ------------------------------------------------------------------ briefing
export async function dailyBriefing(ctx: ToolContext, now = new Date()) {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endOfDay = new Date(startOfDay.getTime() + DAY);
  const q = async (sql: string, p: unknown[]) => Number((await ctx.db.query(sql, p)).rows[0]?.n ?? 0);
  const [meetings, replies, urgent, overdue, blockers, prs, waiting] = await Promise.all([
    q("SELECT count(*) n FROM meetings WHERE owner_user_id=$1 AND status<>'cancelled' AND starts_at >= $2 AND starts_at < $3", [ctx.userId, startOfDay, endOfDay]),
    q("SELECT count(*) n FROM messages WHERE owner_user_id=$1 AND state='open' AND category='needs_reply'", [ctx.userId]),
    q("SELECT count(*) n FROM messages WHERE owner_user_id=$1 AND state='open' AND priority='urgent'", [ctx.userId]),
    q("SELECT count(*) n FROM tasks WHERE owner_user_id=$1 AND status IN ('open','in_progress') AND due_at < $2", [ctx.userId, now]),
    q("SELECT count(*) n FROM tasks WHERE owner_user_id=$1 AND status='blocked'", [ctx.userId]),
    q("SELECT count(*) n FROM messages WHERE owner_user_id=$1 AND state='open' AND source='github' AND kind='approval'", [ctx.userId]),
    q("SELECT count(*) n FROM messages WHERE owner_user_id=$1 AND state='waiting'", [ctx.userId]),
  ]);
  const attention = (await ctx.db.query(
    `SELECT id, source, sender_name, subject, summary, priority, required_action, deadline, sent_at FROM messages
     WHERE owner_user_id=$1 AND state='open' AND priority IN ('urgent','high') ORDER BY (priority='urgent') DESC, deadline NULLS LAST, sent_at DESC LIMIT 5`, [ctx.userId])).rows;
  const canWait = (await ctx.db.query(
    `SELECT id, source, sender_name, subject, summary, sent_at FROM messages WHERE owner_user_id=$1 AND state='open' AND priority IN ('normal','low') ORDER BY sent_at DESC LIMIT 5`, [ctx.userId])).rows;
  const blocked = (await ctx.db.query(`SELECT id, title, external_key FROM tasks WHERE owner_user_id=$1 AND status='blocked' LIMIT 5`, [ctx.userId])).rows;
  const hour = now.getUTCHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const lines = [
    `${greeting}, ${ctx.userName.split(' ')[0]}.`, 'Today you have:',
    `- ${meetings} meeting${meetings === 1 ? '' : 's'}`, `- ${replies} message${replies === 1 ? '' : 's'} needing replies`,
    `- ${blockers} blocked task${blockers === 1 ? '' : 's'}`, `- ${prs} code review${prs === 1 ? '' : 's'} waiting`,
    `- ${overdue} overdue task${overdue === 1 ? '' : 's'}`, `- ${waiting} thread${waiting === 1 ? '' : 's'} waiting on others`,
  ];
  return { greeting: lines.join('\n'), counts: { meetings, replies, urgent, overdue, blockers, prs, waiting }, needsAttentionNow: attention, canWait, blocked };
}

// ------------------------------------------------------------------ proactive suggestions
export interface Suggestion { kind: string; subjectRef: string; title: string; rationale: string; payload: Record<string, unknown> }

/** Every suggestion states why it exists. Nothing here acts; the user decides. */
export async function computeSuggestions(ctx: ToolContext, now = new Date()): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const days = (d: Date) => Math.floor((now.getTime() - d.getTime()) / DAY);

  const waiting = await ctx.db.query(
    `SELECT m.id, m.subject, m.sent_at, m.source, coalesce(m.sender_name, (m.acl)[1]) AS who FROM messages m
     WHERE m.owner_user_id=$1 AND m.direction='outbound' AND m.state='waiting' AND m.sent_at < $2
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.thread_id AND r.direction='inbound' AND r.sent_at > m.sent_at)
     ORDER BY m.sent_at LIMIT 10`, [ctx.userId, new Date(now.getTime() - 3 * DAY)]);
  for (const w of waiting.rows) {
    const d = days(w.sent_at);
    out.push({ kind: 'follow_up', subjectRef: w.id, title: `Follow up on "${w.subject ?? 'your message'}"?`, rationale: `You sent this ${d} days ago on ${w.source} and there is no reply yet.`, payload: { messageId: w.id, daysWaiting: d } });
  }
  const unanswered = await ctx.db.query(
    `SELECT id, subject, sent_at, sender_name FROM messages WHERE owner_user_id=$1 AND state='open' AND category='needs_reply' AND sent_at < $2
       AND sender_address IN (SELECT email FROM contacts WHERE is_vip) ORDER BY sent_at LIMIT 5`, [ctx.userId, new Date(now.getTime() - 2 * DAY)]);
  for (const u of unanswered.rows) out.push({ kind: 'reply_overdue', subjectRef: u.id, title: `Reply to ${u.sender_name ?? 'a key contact'}`, rationale: `A VIP contact wrote ${days(u.sent_at)} days ago and is still waiting for your reply.`, payload: { messageId: u.id } });

  const upcoming = await ctx.db.query('SELECT id, title, starts_at, ends_at FROM meetings WHERE owner_user_id=$1 AND status<>$4 AND starts_at >= $2 AND starts_at < $3', [ctx.userId, now, new Date(now.getTime() + 2 * DAY), 'cancelled']);
  for (const c of overlaps(upcoming.rows)) out.push({ kind: 'meeting_conflict', subjectRef: `${c.a}|${c.b}`, title: `Overlapping meetings: ${c.a} and ${c.b}`, rationale: `Both are on your calendar at ${c.at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, payload: { a: c.a, b: c.b } });

  const prs = await ctx.db.query(`SELECT id, subject, sent_at FROM messages WHERE owner_user_id=$1 AND source='github' AND kind='approval' AND state='open' AND sent_at < $2`, [ctx.userId, new Date(now.getTime() - 4 * DAY)]);
  for (const p of prs.rows) out.push({ kind: 'pr_stale', subjectRef: p.id, title: `Review is waiting: ${p.subject}`, rationale: `This review request has been open for ${days(p.sent_at)} days.`, payload: { messageId: p.id } });

  const blocked = await ctx.db.query(`SELECT id, title, due_at FROM tasks WHERE owner_user_id=$1 AND status='blocked' AND due_at < $2`, [ctx.userId, new Date(now.getTime() + 2 * DAY)]);
  for (const b of blocked.rows) out.push({ kind: 'blocker', subjectRef: b.id, title: `Blocked task due soon: ${b.title}`, rationale: `It is blocked and due ${new Date(b.due_at).toISOString().slice(0, 10)}. Unblocking it now avoids a miss.`, payload: { taskId: b.id } });

  const extracted = await ctx.db.query(`SELECT count(*)::int n FROM tasks WHERE owner_user_id=$1 AND origin='ai_extracted' AND status='open' AND created_at > $2`, [ctx.userId, new Date(now.getTime() - DAY)]);
  if ((extracted.rows[0]?.n ?? 0) > 0) out.push({ kind: 'tasks_detected', subjectRef: 'tasks-today', title: `${extracted.rows[0].n} task(s) were detected in your messages today`, rationale: 'Requests with an owner or deadline were found in conversations. Review and confirm them.', payload: {} });
  return out;
}

export { local };
