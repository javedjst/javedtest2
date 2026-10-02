import type { ToolContext } from './context.js';
import { executeTool, type ExecResult } from './executor.js';
import { toolByName } from './tools.js';

/**
 * Supervisor: turns a free-text command into a plan (which agents and tools run, in what order)
 * and executes it. Planning is rule based so it is deterministic, free and testable. A model planner
 * can replace plan() later without touching execution: whatever plan comes back still has to pass
 * the executor, so a planner cannot widen its own permissions.
 */
export interface PlannedStep {
  tool: string;
  input: Record<string, unknown>;
  /** Optionally derive follow-up steps from this step's output (bounded depth). */
  expand?: (output: unknown) => PlannedStep[];
}
export interface Plan { intent: string; steps: PlannedStep[]; explanation: string }

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function rangeFor(text: string, now: Date): { from: Date; to: Date; label: string } {
  const t = text.toLowerCase();
  const today = startOfDay(now);
  if (/\btomorrow\b/.test(t)) return { from: new Date(today.getTime() + DAY), to: new Date(today.getTime() + 2 * DAY), label: 'tomorrow' };
  if (/\bnext week\b/.test(t)) {
    const toMonday = ((8 - today.getUTCDay()) % 7) || 7;
    const mon = new Date(today.getTime() + toMonday * DAY);
    return { from: mon, to: new Date(mon.getTime() + 5 * DAY), label: 'next week' };
  }
  if (/\bthis week\b/.test(t)) return { from: today, to: new Date(today.getTime() + 7 * DAY), label: 'this week' };
  return { from: today, to: new Date(today.getTime() + DAY), label: 'today' };
}

export function plan(text: string, now = new Date()): Plan {
  const t = text.trim();
  const l = t.toLowerCase();
  let m: RegExpMatchArray | null;

  if (/\b(everything|all|anything|what).{0,30}\b(reply|respond|answer)\b/.test(l) || /\bneeds? (a )?repl/.test(l))
    return { intent: 'needs_reply', explanation: 'Listing open items that need your reply', steps: [{ tool: 'list_inbox', input: { filter: 'needs_reply' } }] };

  if (/\b(prepare|brief|ready).{0,30}meetings?\b/.test(l)) {
    const r = rangeFor(l, now);
    return {
      intent: 'prepare_meetings', explanation: `Building briefs for your meetings ${r.label}`,
      steps: [{ tool: 'list_meetings', input: { from: r.from, to: r.to }, expand: (out) => (out as { id: string }[]).slice(0, 8).map((x) => ({ tool: 'meeting_brief', input: { meetingId: x.id } })) }],
    };
  }

  if (/\bschedule\b.*\b(meeting|call|sync)\b|\bfind (a )?(time|slot)/.test(l)) {
    const r = rangeFor(l, now);
    const who = t.match(/\bwith ([A-Z][\w.'-]*)/)?.[1];
    return { intent: 'schedule_meeting', explanation: `Finding free slots ${r.label}${who ? ` for a meeting with ${who}` : ''}. Pick one to create the event.`, steps: [{ tool: 'find_free_slots', input: { durationMin: /\bhour\b/.test(l) ? 60 : 30, from: r.from, to: r.to } }] };
  }

  if (/\b(summari[sz]e|summary|briefing|overview)\b.*\b(today|day|work)\b|\bgood morning\b|\bwhat('s| is) (on )?(my )?(today|plate)/.test(l))
    return { intent: 'daily_briefing', explanation: 'Preparing your daily briefing', steps: [{ tool: 'daily_briefing', input: {} }, { tool: 'list_suggestions', input: {} }] };

  if ((m = l.match(/\breply to (?:the )?(?:latest|last|newest) (.+?)(?: email| message| mail)?$/)))
    return {
      intent: 'reply_latest', explanation: `Finding the latest message about "${m[1]}" and drafting replies`,
      steps: [{ tool: 'search_workspace', input: { query: m[1]!, limit: 5 }, expand: (out) => {
        const first = (out as { id: string; kind: string; at: string }[]).filter((h) => h.kind === 'message').sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
        return first ? [{ tool: 'suggest_replies', input: { messageId: first.id } }] : [];
      } }],
    };

  if (/\bgithub\b|\bpull requests?\b|\bprs?\b/.test(l)) {
    const kind = /review|waiting|pull|\bprs?\b/.test(l) ? 'reviews' : /security|vulnerab/.test(l) ? 'security' : /production|ci|deploy|build/.test(l) ? 'ci' : 'all';
    return { intent: 'github', explanation: `Checking GitHub (${kind})`, steps: [{ tool: 'github_activity', input: { kind, days: /week/.test(l) ? 7 : 3 } }] };
  }

  if (/\b(create|make|turn).{0,20}(jira )?(tasks?|tickets?).{0,30}\b(meeting|conversation|email|slack)\b/.test(l))
    return { intent: 'tasks_from_source', explanation: 'Extracting action items. Nothing is created until you confirm.', steps: [{ tool: 'meeting_action_items', input: {} }] };

  if (/\b(overdue|my tasks|blocked tasks|blockers?)\b/.test(l))
    return { intent: 'tasks', explanation: 'Listing tasks', steps: [{ tool: 'list_tasks', input: { status: /overdue/.test(l) ? 'overdue' : /block/.test(l) ? 'blocked' : 'open' } }] };

  if ((m = t.match(/\bwhat happened (?:with|to|on) (.+?)\??$/i)) || (m = t.match(/\btimeline (?:of|for) (.+)$/i)))
    return { intent: 'timeline', explanation: `Building a timeline for ${m[1]}`, steps: [{ tool: 'build_timeline', input: { subject: m[1] } }] };

  if (/^(write|draft|compose|email|send an? |reply to|tell )/.test(l) || /\b(write|draft) (an? )?(email|slack|whatsapp|message|update|follow-?up)/.test(l))
    return { intent: 'compose', explanation: 'Drafting a message. It will not be sent without your approval.', steps: [{ tool: 'compose_draft', input: { instruction: t } }] };

  if (/^(find|show|search|where|locate|look up|get)\b/.test(l)) {
    const q = t.replace(/^(find|show|search( for)?|locate|look up|get)( me)?( the| our| my)?\s*/i, '');
    return { intent: 'search', explanation: `Searching everything you have access to for "${q}"`, steps: [{ tool: 'search_workspace', input: { query: q } }] };
  }

  return { intent: 'ask', explanation: 'Answering from the sources you have access to', steps: [{ tool: 'ask_company', input: { question: t } }] };
}

export interface StepOutcome { tool: string; agent: string; input: unknown; result: ExecResult }
export interface CommandResult { intent: string; explanation: string; agents: string[]; steps: StepOutcome[] }

export async function runCommand(ctx: ToolContext, text: string, now = new Date()): Promise<CommandResult> {
  const p = plan(text, now);
  const steps: StepOutcome[] = [];
  const queue: { step: PlannedStep; depth: number }[] = p.steps.map((step) => ({ step, depth: 0 }));
  while (queue.length && steps.length < 12) {
    const { step, depth } = queue.shift()!;
    const agent = toolByName.get(step.tool)?.agent ?? 'supervisor';
    const result = await executeTool(ctx, agent, step.tool, step.input);
    steps.push({ tool: step.tool, agent, input: step.input, result });
    if (result.status === 'executed' && step.expand && depth < 2) for (const s of step.expand(result.output)) queue.push({ step: s, depth: depth + 1 });
  }
  return { intent: p.intent, explanation: p.explanation, agents: ['supervisor', ...new Set(steps.map((s) => s.agent))], steps };
}
