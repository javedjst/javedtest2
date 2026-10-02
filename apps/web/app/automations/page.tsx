'use client';
import { useState } from 'react';
import { Card, Empty, ErrorNote, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const TEMPLATES: Record<string, { name: string; trigger: object; steps: { tool: string; input: object }[] }> = {
  'Important client email': { name: 'Important client email', trigger: { on: 'message.received', filter: { vip: true } }, steps: [{ tool: 'list_inbox', input: { filter: 'needs_reply', limit: 5 } }, { tool: 'suggest_replies', input: {} }] },
  'After every meeting': { name: 'After every meeting', trigger: { on: 'meeting.ended' }, steps: [{ tool: 'meeting_action_items', input: {} }, { tool: 'create_task', input: {} }, { tool: 'compose_draft', input: { instruction: 'Write a follow-up email with the meeting summary' } }, { tool: 'send_message', input: { channel: 'email' } }] },
  'Failed deployment': { name: 'Failed deployment', trigger: { on: 'github.deploy.failed' }, steps: [{ tool: 'github_activity', input: { kind: 'ci' } }, { tool: 'create_jira_ticket', input: { project: 'OPS' } }, { tool: 'send_message', input: { channel: 'slack' } }] },
};

export default function Automations() {
  const list = useApi<any[]>('/automations');
  const [key, setKey] = useState('After every meeting');
  const [autoSend, setAutoSend] = useState(false);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = TEMPLATES[key]!;
  async function show() { setErr(null); try { setPreview((await api<any>('/automations/preview', { body: { steps: t.steps, autoSend } })).actions); } catch (e) { setErr((e as Error).message); } }
  async function create() { try { await api('/automations', { body: { name: t.name, trigger: t.trigger, steps: t.steps, autoSend } }); setPreview(null); list.reload(); } catch (e) { setErr((e as Error).message); } }
  return (
    <Page title="Automations" subtitle="Every automation shows exactly what it will do before you can turn it on. New ones start disabled.">
      <Card title="New automation">
        <select value={key} onChange={(e) => { setKey(e.target.value); setPreview(null); }} aria-label="Template">{Object.keys(TEMPLATES).map((k) => <option key={k}>{k}</option>)}</select>
        <p className="meta">Trigger: <code>{JSON.stringify(t.trigger)}</code></p>
        <label className="row"><input type="checkbox" checked={autoSend} onChange={(e) => { setAutoSend(e.target.checked); setPreview(null); }} style={{ width: 'auto' }} /> Allow high risk steps (send, merge, delete) to run without asking me. Off by default.</label>
        <div className="row" style={{ marginTop: 8 }}><button className="btn" onClick={show}>Show what it will do</button>{preview && <button className="btn primary" onClick={create}>Create (disabled)</button>}</div>
        <ErrorNote message={err} />
        {preview && <table><thead><tr><th>#</th><th>Action</th><th>Agent</th><th>Risk</th><th>Runs without asking?</th></tr></thead><tbody>{preview.map((a) => <tr key={a.step}><td>{a.step}</td><td>{a.description}</td><td>{a.agent}</td><td><span className={`badge risk-${a.risk}`}>{a.risk}</span></td><td>{a.runsWithoutApproval ? 'Yes' : 'No, waits for approval'}</td></tr>)}</tbody></table>}
      </Card>
      <Card title="Your automations">
        {list.data?.length ? <ul className="list">{list.data.map((a) => <li key={a.id} className="row-item split"><span><strong>{a.name}</strong> <span className="meta">{a.steps.length} steps{a.auto_send ? ' · auto-run high risk' : ''}</span></span>
          <button className="btn small" onClick={async () => { await api(`/automations/${a.id}/enable`, { body: { enabled: !a.enabled } }); list.reload(); }}>{a.enabled ? 'Disable' : 'Enable'}</button></li>)}</ul> : <Empty>None yet.</Empty>}
        <p className="meta">The trigger runner (event matching and step execution) is on the roadmap. Today automations are stored, previewed, audited and can be switched on or off.</p>
      </Card>
    </Page>
  );
}
