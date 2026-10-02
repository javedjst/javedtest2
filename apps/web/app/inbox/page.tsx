'use client';
import { useState } from 'react';
import { MessageRow, ReplyPanel } from '@/components/Results';
import { Card, Empty, ErrorNote, Page, SourceTag, Priority, when } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const FILTERS = [['all', 'All'], ['urgent', 'Urgent'], ['needs_reply', 'Needs reply'], ['waiting', 'Waiting for someone'], ['fyi', 'FYI'], ['meeting', 'Meetings'], ['task', 'Tasks'], ['approval', 'Approvals']];
const SOURCES = ['', 'gmail', 'slack', 'github', 'jira'];

export default function Inbox() {
  const [filter, setFilter] = useState('all');
  const [source, setSource] = useState('');
  const list = useApi<any[]>(`/inbox?filter=${filter}${source ? `&source=${source}` : ''}&limit=60`);
  const [open, setOpen] = useState<any | null>(null);
  const [replies, setReplies] = useState<any | null>(null);
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function select(m: any) {
    setOpen(m); setReplies(null); setTasks(null); setErr(null); setBusy(true);
    try {
      const [r, t] = await Promise.all([api<any>(`/messages/${m.id}/replies`, { method: 'POST', body: {} }), api<any[]>(`/messages/${m.id}/tasks/extract`, { method: 'POST', body: {} })]);
      setReplies(r); setTasks(t);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function addTask(t: any) {
    await api('/tasks', { body: { title: t.title, dueAt: t.deadline, source: t.source, sourceRef: t.sourceRef, origin: 'ai_extracted' } });
    setTasks((x) => (x ?? []).filter((y) => y !== t));
  }
  async function resolve(state: string) {
    await api(`/messages/${open.id}/resolve`, { body: { state } });
    setOpen(null); list.reload();
  }

  return (
    <Page title="Inbox" subtitle="Mail, chat, tickets and code notifications in one prioritised list.">
      <div className="tabs" role="tablist">{FILTERS.map(([k, label]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k!)}>{label}</button>)}</div>
      <div className="row" style={{ marginBottom: 12 }}><label className="meta">Source <select value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 'auto' }}>{SOURCES.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}</select></label></div>
      <ErrorNote message={list.error} />
      <div className="grid" style={{ gridTemplateColumns: open ? 'minmax(320px,1fr) minmax(360px,1.2fr)' : '1fr' }}>
        <Card>{list.loading ? <Empty>Loading…</Empty> : list.data?.length ? <ul className="list">{list.data.map((m) => <MessageRow key={m.id} m={m} onOpen={() => select(m)} />)}</ul> : <Empty>Nothing in this view.</Empty>}</Card>
        {open && (
          <Card title={open.subject ?? 'Message'} action={<button className="linkbtn" onClick={() => setOpen(null)}>Close</button>}>
            <div className="row"><SourceTag source={open.source} /><strong>{open.sender_name}</strong><Priority p={open.priority} /><span className="meta">{when(open.sent_at)}</span></div>
            {open.summary && <p><strong>Summary:</strong> {open.summary}</p>}
            {open.required_action && <p className="meta">Required action: {open.required_action}</p>}
            <ErrorNote message={err} />
            {busy && <Empty>Thinking…</Empty>}
            {tasks && tasks.length > 0 && <><h5>Tasks detected</h5>{tasks.map((t, i) => <div key={i} className="split"><span>{t.title} <span className="meta">· {t.owner ?? 'unassigned'}{t.deadline ? ` · due ${new Date(t.deadline).toLocaleDateString()}` : ''}</span></span><button className="btn small" onClick={() => addTask(t)}>Add task</button></div>)}</>}
            {replies && <><h5>Suggested replies</h5><ReplyPanel data={replies} /></>}
            <div className="row" style={{ marginTop: 10 }}><button className="btn small" onClick={() => resolve('done')}>Mark done</button><button className="btn small" onClick={() => resolve('snoozed')}>Snooze</button></div>
          </Card>
        )}
      </div>
    </Page>
  );
}
