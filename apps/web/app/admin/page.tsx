'use client';
import { useState } from 'react';
import { Card, Empty, ErrorNote, Page, when } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const TABS = ['Audit log', 'AI actions', 'Approval policies', 'Users', 'Integrations'];

export default function Admin() {
  const [tab, setTab] = useState(TABS[0]!);
  return (
    <Page title="Admin" subtitle="Control what the AI can do, who can do what, and review everything it did.">
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'Audit log' && <Audit />}{tab === 'AI actions' && <Actions />}{tab === 'Approval policies' && <Policies />}{tab === 'Users' && <Users />}{tab === 'Integrations' && <Integ />}
    </Page>
  );
}

function Audit() {
  const log = useApi<any[]>('/admin/audit?limit=150');
  const [verify, setVerify] = useState<string | null>(null);
  return (
    <Card title="Audit log" action={<button className="btn small" onClick={async () => { const r = await api<any>('/admin/audit/verify'); setVerify(r.ok ? `Chain intact (${r.checked} entries)` : `Tampering detected at entry ${r.firstBrokenId}`); }}>Verify integrity</button>}>
      {verify && <p className={verify.startsWith('Chain') ? 'ok' : 'error'}>{verify}</p>}<ErrorNote message={log.error} />
      {log.data?.length ? <table><thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Target</th><th>Detail</th></tr></thead><tbody>{log.data.map((r) => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.event}</td><td>{r.actor_kind}</td><td>{r.target}</td><td className="meta">{JSON.stringify(r.detail)}</td></tr>)}</tbody></table> : <Empty>No entries.</Empty>}
    </Card>
  );
}

function Actions() {
  const a = useApi<any[]>('/admin/actions');
  return <Card title="Everything agents did or tried to do"><ErrorNote message={a.error} />{a.data?.length ? <table><thead><tr><th>When</th><th>User</th><th>Agent</th><th>Tool</th><th>Risk</th><th>Status</th></tr></thead><tbody>{a.data.map((r) => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.email}</td><td>{r.agent}</td><td>{r.tool}</td><td><span className={`badge risk-${r.risk}`}>{r.risk}</span></td><td>{r.status}</td></tr>)}</tbody></table> : <Empty>No actions yet.</Empty>}</Card>;
}

function Policies() {
  const p = useApi<any[]>('/admin/policies');
  const t = useApi<{ tools: any[] }>('/agents');
  const [action, setAction] = useState('send_message');
  const [mode, setMode] = useState('require_approval');
  const [approver, setApprover] = useState('self');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Approval policies">
      <p className="meta">Defaults: low risk runs, medium risk runs and is audited, high risk always asks. Policies below override the defaults. “deny” turns an action off for everyone.</p>
      <div className="grid2">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action"><option value="*:medium">All medium risk actions</option><option value="*:high">All high risk actions</option>{t.data?.tools.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.risk})</option>)}</select>
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode"><option value="allow">allow</option><option value="require_approval">require approval</option><option value="deny">deny</option></select>
        <select value={approver} onChange={(e) => setApprover(e.target.value)} aria-label="Approver"><option value="self">approved by the requester</option><option value="admin">approved by a different admin</option></select>
        <button className="btn primary" onClick={async () => { setErr(null); try { const cls = action.startsWith('*:'); await api('/admin/policies', { method: 'PUT', body: { action: cls ? '*' : action, risk: cls ? action.slice(2) : null, mode, approverRole: approver } }); p.reload(); } catch (e) { setErr((e as Error).message); } }}>Save policy</button>
      </div>
      <ErrorNote message={err ?? p.error} />
      {p.data?.length ? <table><thead><tr><th>Action</th><th>Risk class</th><th>Mode</th><th>Approver</th></tr></thead><tbody>{p.data.map((r) => <tr key={`${r.action}${r.risk}`}><td>{r.action}</td><td>{r.risk ?? ''}</td><td>{r.mode}</td><td>{r.approver_role}</td></tr>)}</tbody></table> : <Empty>No custom policies. Defaults apply.</Empty>}
    </Card>
  );
}

function Users() {
  const u = useApi<any[]>('/admin/users');
  const [err, setErr] = useState<string | null>(null);
  const patch = async (id: string, body: object) => { setErr(null); try { await api(`/admin/users/${id}`, { method: 'PATCH', body }); u.reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <Card title="Users and roles"><ErrorNote message={err ?? u.error} />
      {u.data?.length ? <table><thead><tr><th>User</th><th>Role</th><th>MFA</th><th>Status</th><th /></tr></thead><tbody>{u.data.map((x) => <tr key={x.id}><td>{x.display_name}<div className="meta">{x.email}</div></td>
        <td><select value={x.role} onChange={(e) => patch(x.id, { role: e.target.value })} style={{ width: 'auto' }} aria-label={`Role for ${x.email}`}>{['owner', 'admin', 'member', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select></td><td>{x.mfa_enrolled ? 'enrolled' : 'no'}</td><td>{x.disabled_at ? 'disabled' : 'active'}</td>
        <td><button className="btn small" onClick={() => patch(x.id, { disabled: !x.disabled_at })}>{x.disabled_at ? 'Enable' : 'Disable and sign out'}</button></td></tr>)}</tbody></table> : <Empty>No users.</Empty>}</Card>
  );
}

function Integ() {
  const i = useApi<any[]>('/admin/integrations');
  return <Card title="Connected accounts"><ErrorNote message={i.error} />{i.data?.length ? <table><thead><tr><th>Provider</th><th>Account</th><th>User</th><th>Status</th></tr></thead><tbody>{i.data.map((x) => <tr key={x.id}><td>{x.provider}</td><td>{x.external_account}</td><td>{x.user_email ?? 'org-wide'}</td><td>{x.status}{x.last_error ? ` · ${x.last_error}` : ''}</td></tr>)}</tbody></table> : <Empty>Nothing connected yet.</Empty>}</Card>;
}
