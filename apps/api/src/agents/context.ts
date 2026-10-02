import type { Db } from '../db.js';
import type { Role } from '../security/rbac.js';

export interface ToolContext {
  db: Db;
  orgId: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: Role;
  ip?: string;
  /** Who is driving: a person in the UI, or an automation (which may carry an auto-run opt-in). */
  origin: 'user' | 'automation';
  automationAutoRun?: boolean;
}

/** Principals whose items this user may read. Used by every retrieval query. */
export async function principalsFor(ctx: Pick<ToolContext, 'db' | 'userId' | 'userEmail' | 'role'>): Promise<string[]> {
  const teams = await ctx.db.query<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = $1', [ctx.userId]);
  const grants = await ctx.db.query<{ resource: string; effect: string }>(
    "SELECT resource, effect FROM permissions WHERE principal = ANY($1)",
    [[`user:${ctx.userId}`, `role:${ctx.role}`, ...teams.rows.map((t) => `team:${t.team_id}`)]],
  );
  const denied = new Set(grants.rows.filter((g) => g.effect === 'deny').map((g) => g.resource));
  const allowed = grants.rows.filter((g) => g.effect === 'allow' && !denied.has(g.resource)).map((g) => g.resource);
  return ['org:*', `user:${ctx.userId}`, `mailbox:${ctx.userEmail.toLowerCase()}`, ...teams.rows.map((t) => `team:${t.team_id}`), ...allowed];
}
