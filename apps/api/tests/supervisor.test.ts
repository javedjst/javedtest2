import { describe, expect, it } from 'vitest';
import { plan } from '../src/agents/supervisor.js';
import { listAgents } from '../src/agents/registry.js';
import { tools } from '../src/agents/tools.js';
import { gmailAdapter } from '../src/integrations/gmail.js';
import { githubAdapter } from '../src/integrations/github.js';
import { listAdapters, requireOperation } from '../src/integrations/registry.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const first = (t: string) => plan(t, NOW).steps[0]!.tool;

describe('supervisor routing (commands from the brief)', () => {
  it.each([
    ['Show everything I need to reply to.', 'list_inbox'],
    ["Summarise today's work.", 'daily_briefing'],
    ['Schedule a meeting with Kartik next week.', 'find_free_slots'],
    ['Find the AWS security document.', 'search_workspace'],
    ['Reply to the latest Cleartrip email.', 'search_workspace'],
    ["Create Jira tasks from today's meeting.", 'meeting_action_items'],
    ['Show GitHub production issues.', 'github_activity'],
    ['Prepare my meetings for tomorrow.', 'list_meetings'],
    ['What happened with the Cleartrip security assessment?', 'build_timeline'],
    ['Write an email to the team about the delay', 'compose_draft'],
    ['What is our incident response process?', 'ask_company'],
  ])('%s -> %s', (text, tool) => expect(first(text)).toBe(tool));

  it('schedule next week searches Monday to Friday', () => {
    const s = plan('Schedule a meeting with Kartik next week', NOW).steps[0]!;
    expect((s.input.from as Date).toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
  it('never plans a high risk tool directly from free text', () => {
    for (const t of ['send an email to everyone', 'delete all my memory', 'merge the pull request']) {
      const high = plan(t, NOW).steps.map((s) => tools.find((x) => x.name === s.tool)?.risk);
      expect(high).not.toContain('high');
    }
  });
});

describe('tool registry', () => {
  it('declares the documented risk levels', () => {
    const risk = (n: string) => tools.find((t) => t.name === n)?.risk;
    expect(risk('search_workspace')).toBe('low');
    expect(risk('compose_draft')).toBe('low');
    expect(risk('create_task')).toBe('medium');
    expect(risk('create_jira_ticket')).toBe('medium');
    expect(risk('send_message')).toBe('high');
    expect(risk('forget_memory')).toBe('high');
  });
  it('every agent a tool names exists', () => {
    const names = new Set(listAgents().map((a) => a.name));
    for (const t of tools) expect(names.has(t.agent)).toBe(true);
  });
});

describe('integration adapter contract', () => {
  it('ready adapters implement every operation they declare', () => {
    for (const a of listAdapters().filter((x) => x.status === 'ready'))
      for (const op of a.supports) expect(typeof (a as unknown as Record<string, unknown>)[op], `${a.provider}.${op}`).toBe('function');
  });
  it('planned adapters implement nothing, so they cannot be called by accident', () => {
    for (const a of listAdapters().filter((x) => x.status === 'planned')) expect(a.sync).toBeUndefined();
  });
  it('rejects undeclared and unimplemented operations', () => {
    expect(() => requireOperation('gmail', 'create')).toThrow(/does not support/);
    expect(() => requireOperation('slack', 'send')).toThrow();
    expect(requireOperation('gmail', 'send')).toBe(gmailAdapter);
    expect(requireOperation('github', 'create')).toBe(githubAdapter);
  });
  it('MVP integrations are all registered', () => {
    const p = listAdapters().map((a) => a.provider);
    for (const x of ['gmail', 'gcal', 'slack', 'github', 'jira', 'confluence']) expect(p).toContain(x);
  });
});
