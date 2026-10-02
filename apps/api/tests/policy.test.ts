import { describe, expect, it } from 'vitest';
import { decide } from '../src/agents/policy.js';

describe('approval policy', () => {
  it('defaults: reads and drafts run, high risk needs approval', () => {
    expect(decide({ tool: 'search_workspace', risk: 'low', policies: [] }).mode).toBe('allow');
    expect(decide({ tool: 'create_task', risk: 'medium', policies: [] }).mode).toBe('allow');
    expect(decide({ tool: 'send_message', risk: 'high', policies: [] }).mode).toBe('require_approval');
  });
  it('an automation opt-in relaxes only the built-in default', () => {
    expect(decide({ tool: 'send_message', risk: 'high', policies: [], automationAutoRun: true }).mode).toBe('allow');
  });
  it('an org policy beats an automation opt-in', () => {
    const policies = [{ action: 'send_message', risk: null, mode: 'require_approval' as const }];
    expect(decide({ tool: 'send_message', risk: 'high', policies, automationAutoRun: true }).mode).toBe('require_approval');
  });
  it('tool policy beats class policy; deny is final', () => {
    const policies = [{ action: '*', risk: 'high' as const, mode: 'deny' as const }, { action: 'send_message', risk: null, mode: 'require_approval' as const, approver_role: 'admin' as const }];
    const d = decide({ tool: 'send_message', risk: 'high', policies });
    expect(d).toMatchObject({ mode: 'require_approval', approverRole: 'admin' });
    expect(decide({ tool: 'forget_memory', risk: 'high', policies }).mode).toBe('deny');
  });
  it('admins can tighten medium risk actions', () => {
    expect(decide({ tool: 'create_task', risk: 'medium', policies: [{ action: '*', risk: 'medium', mode: 'require_approval' }] }).mode).toBe('require_approval');
  });
});
