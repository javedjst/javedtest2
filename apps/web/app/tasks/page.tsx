'use client';
import { useState } from 'react';
import { Card, Empty, ErrorNote, Page, day } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Tasks() {
  const [status, setStatus] = useState('open');
  const list = useApi<any[]>(`/tasks?status=${status}`);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const set = async (id: string, s: string) => { await api(`/tasks/${id}`, { method: 'PATCH', body: { status: s } }); list.reload(); };
  return (
    <Page title="Tasks" subtitle="From email, chat, meetings, Jira and GitHub in one list.">
      <div className="tabs">{['open', 'overdue', 'blocked', 'done', 'all'].map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s}</button>)}</div>
      <Card title="Add a task">
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await api('/tasks', { body: { title, dueAt: due ? new Date(due).toISOString() : null } }); setTitle(''); setDue(''); list.reload(); }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="Task title" style={{ flex: 1, minWidth: 220 }} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" style={{ width: 160 }} />
          <button className="btn primary" disabled={title.trim().length < 2}>Add</button>
        </form>
      </Card>
      <ErrorNote message={list.error} />
      <Card>
        {list.data?.length ? <table><thead><tr><th>Task</th><th>Status</th><th>Due</th><th>Source</th><th /></tr></thead><tbody>{list.data.map((t) => (
          <tr key={t.id}><td><strong>{t.title}</strong>{t.external_key && <span className="chip" style={{ marginLeft: 6 }}>{t.external_key}</span>}</td><td>{t.status}</td><td>{t.due_at ? day(t.due_at) : ''}</td><td>{t.origin.replace('_', ' ')}{t.source ? ` · ${t.source}` : ''}</td>
            <td>{t.status !== 'done' && <button className="btn small" onClick={() => set(t.id, 'done')}>Done</button>} {t.status !== 'blocked' && t.status !== 'done' && <button className="btn small" onClick={() => set(t.id, 'blocked')}>Blocked</button>}</td></tr>))}</tbody></table> : <Empty>No tasks.</Empty>}
      </Card>
      <p className="meta">Converting a task to a Jira issue needs the Jira integration (planned). The create_jira_ticket tool already exists and goes through approval.</p>
    </Page>
  );
}
