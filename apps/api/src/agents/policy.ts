export type Risk = 'low' | 'medium' | 'high';
export type Mode = 'allow' | 'require_approval' | 'deny';

export interface PolicyRow { action: string; risk: Risk | null; mode: Mode; approver_role?: 'self' | 'admin' }

export const DEFAULT_MODE: Record<Risk, Mode> = {
  low: 'allow',              // search, summarise, read, draft
  medium: 'allow',           // create task / meeting, update Jira. Audited. Admins can tighten.
  high: 'require_approval',  // send, merge, delete, deploy
};

export interface DecideInput {
  tool: string;
  risk: Risk;
  policies: PolicyRow[];
  /** Set only when the user explicitly enabled auto-run on an automation they own. */
  automationAutoRun?: boolean;
}

export interface Decision { mode: Mode; reason: string; approverRole: 'self' | 'admin' }

/**
 * Precedence, strongest first:
 *  1. org policy for this exact tool
 *  2. org policy for this risk class (action = '*')
 *  3. user's explicit automation opt-in, which may relax only the built-in default
 *  4. built-in default
 * A 'deny' anywhere in 1 or 2 is final. Org policies cannot be relaxed by an automation.
 */
export function decide(i: DecideInput): Decision {
  const tool = i.policies.find((p) => p.action === i.tool);
  if (tool) return { mode: tool.mode, reason: `org policy for ${i.tool}`, approverRole: tool.approver_role ?? 'self' };
  const cls = i.policies.find((p) => p.action === '*' && p.risk === i.risk);
  if (cls) return { mode: cls.mode, reason: `org policy for ${i.risk} risk actions`, approverRole: cls.approver_role ?? 'self' };
  if (i.risk === 'high' && i.automationAutoRun) return { mode: 'allow', reason: 'automation with explicit auto-run enabled by the user', approverRole: 'self' };
  return { mode: DEFAULT_MODE[i.risk], reason: `default for ${i.risk} risk`, approverRole: 'self' };
}
