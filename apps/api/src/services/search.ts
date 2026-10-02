import { answerWithSources } from '../ai/index.js';
import type { ToolContext } from '../agents/context.js';
import { principalsFor } from '../agents/context.js';

export interface Hit { id: string; kind: 'message' | 'document' | 'meeting' | 'task'; source: string; title: string; snippet: string; url?: string | null; at: string; rank: number }

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'about', 'that', 'this', 'from', 'our', 'was', 'were', 'how', 'did', 'does', 'show', 'find', 'any', 'all', 'are', 'you', 'who', 'when', 'where', 'which']);

/** Natural language to an OR tsquery. Only letters and digits survive, so no tsquery syntax can be injected. */
export function toTsQuery(input: string): string {
  const words = input.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12).join(' | ');
}

/**
 * Permission-aware retrieval. The ACL filter runs inside the SQL query, before ranking and before
 * anything is shown to a model. A document the user cannot read never enters the prompt.
 */
export async function searchWorkspace(ctx: ToolContext, query: string, limit = 12): Promise<Hit[]> {
  const principals = await principalsFor(ctx);
  const q = toTsQuery(query);
  if (!q) return [];
  const like = query.replace(/[%_\\]/g, ' ').trim();
  const [msgs, docs, tasks, meets] = await Promise.all([
    ctx.db.query(
      `SELECT id, source, coalesce(subject, '(no subject)') AS title, coalesce(summary, left(body, 200)) AS snippet, sent_at AS at,
              ts_rank(search_tsv, to_tsquery('english', $1)) AS rank
       FROM messages WHERE search_tsv @@ to_tsquery('english', $1) AND acl && $2::text[]
       ORDER BY rank DESC, sent_at DESC LIMIT $3`, [q, principals, limit]),
    ctx.db.query(
      `SELECT id, source, title, left(body, 240) AS snippet, url, updated_at AS at,
              ts_rank(search_tsv, to_tsquery('english', $1)) AS rank
       FROM documents WHERE search_tsv @@ to_tsquery('english', $1) AND acl && $2::text[]
       ORDER BY rank DESC LIMIT $3`, [q, principals, limit]),
    ctx.db.query(
      `SELECT id, title, coalesce(description, '') AS snippet, created_at AS at FROM tasks
       WHERE (owner_user_id = $2) AND (title ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%') LIMIT $3`, [like, ctx.userId, limit]),
    ctx.db.query(
      `SELECT id, title, coalesce(agenda, '') AS snippet, starts_at AS at FROM meetings
       WHERE owner_user_id = $2 AND (title ILIKE '%' || $1 || '%' OR agenda ILIKE '%' || $1 || '%') LIMIT $3`, [like, ctx.userId, limit]),
  ]);
  const hits: Hit[] = [
    ...msgs.rows.map((r): Hit => ({ id: r.id, kind: 'message', source: r.source, title: r.title, snippet: r.snippet, at: r.at, rank: Number(r.rank) })),
    ...docs.rows.map((r): Hit => ({ id: r.id, kind: 'document', source: r.source, title: r.title, snippet: r.snippet, url: r.url, at: r.at, rank: Number(r.rank) + 0.1 })),
    ...tasks.rows.map((r): Hit => ({ id: r.id, kind: 'task', source: 'tasks', title: r.title, snippet: r.snippet, at: r.at, rank: 0.05 })),
    ...meets.rows.map((r): Hit => ({ id: r.id, kind: 'meeting', source: 'calendar', title: r.title, snippet: r.snippet, at: r.at, rank: 0.05 })),
  ];
  return hits.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

/** "What happened with X?" → hits sorted oldest first so the UI can render a timeline. */
export async function timeline(ctx: ToolContext, subject: string) {
  const hits = await searchWorkspace(ctx, subject, 40);
  return hits.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export async function askCompany(ctx: ToolContext, question: string) {
  const hits = await searchWorkspace(ctx, question, 8);
  const { answer, engine } = await answerWithSources(question, hits.map((h) => ({ title: h.title, url: h.url, text: h.snippet })));
  return { answer, engine, sources: hits };
}
