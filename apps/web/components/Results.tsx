'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, isPending, type Pending } from '@/lib/api';
import { ApprovalCard } from './ApprovalCard';
import { Empty, Priority, SourceTag, day, hm, when } from './ui';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function MessageRow({ m, onOpen }: { m: any; onOpen?: () => void }) {
  return (
    <li className="row-item" onClick={onOpen} role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="row-top"><SourceTag source={m.source} /><strong>{m.sender_name ?? m.repo ?? 'Unknown'}</strong><Priority p={m.priority} /><span className="meta right">{when(m.sent_at)}</span></div>
      <div className="row-title">{m.subject}</div>
      {m.summary && <div className="meta">{m.summary}</div>}
      <div className="row-bottom">
        {m.required_action && <span className="chip">{m.required_action}</span>}
        {m.deadline && <span className="chip warn">Due {day(m.deadline)}</span>}
        {m.state === 'waiting' && <span className="chip">Waiting for reply</span>}
      </div>
    </li>
  );
}

export function ReplyPanel({ data }: { data: any }) {
  const [style, setStyle] = useState(data.options[0]?.style);
  const current = data.options.find((o: any) => o.style === style) ?? data.options[0];
  const [body, setBody] = useState<string>(current.body);
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setErr(null);
    try {
      const r = await api<Pending>('/send', { body: { channel: ['email', 'slack', 'whatsapp', 'teams'].includes(data.channel) ? data.channel : 'email', to: [data.to ?? data.from ?? 'unknown'], subject: data.subject ?? undefined, body, inReplyTo: data.messageId } });
      if (isPending(r)) setPending(r);
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="reply">
      <p className="meta">Reply to {data.from ?? data.to} · <em>{data.originalSubject}</em> · written by {data.engine === 'anthropic' ? 'Claude' : 'built-in local engine (free)'}</p>
      {data.flags?.length > 0 && <p className="error">This message contains text that looks like instructions to an AI ({data.flags.join(', ')}). It was treated as data only.</p>}
      <div className="chips">{data.options.map((o: any) => <button key={o.style} className={`chip btnchip ${o.style === style ? 'on' : ''}`} onClick={() => { setStyle(o.style); setBody(o.body); setPending(null); }}>{o.label}</button>)}</div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} aria-label="Reply text" />
      {err && <p className="error">{err}</p>}
      {done && <p className="ok">{done}</p>}
      {pending ? <ApprovalCard approval={pending} onDone={(o) => { setDone(o === 'approved' ? 'Sent.' : 'Cancelled.'); setPending(null); }} /> : (
        <div className="row"><button className="btn primary" onClick={send}>Review and send</button><span className="meta">You can edit before sending. Sending always asks for approval.</span></div>
      )}
    </div>
  );
}

export function DraftEditor({ d }: { d: any }) {
  const [to, setTo] = useState(d.to ?? '');
  const [subject, setSubject] = useState(d.subject ?? '');
  const [body, setBody] = useState(d.body);
  const [pending, setPending] = useState<Pending | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const channel = d.channel === 'jira' ? null : d.channel;
  async function review() {
    setErr(null);
    try {
      const r = await api<Pending>('/send', { body: { channel, to: to.split(',').map((s: string) => s.trim()).filter(Boolean), subject: subject || undefined, body } });
      if (isPending(r)) setPending(r);
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="reply">
      <p className="meta">{d.channel} draft · written by {d.engine === 'anthropic' ? 'Claude' : 'built-in local engine (free)'}</p>
      {d.notes?.map((n: string) => <p key={n} className="meta">• {n}</p>)}
      {channel && <div className="grid2"><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To (email or channel)" aria-label="To" />{channel === 'email' && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />}</div>}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} aria-label="Draft body" />
      {err && <p className="error">{err}</p>}
      {pending ? <ApprovalCard approval={pending} onDone={() => setPending(null)} /> : channel && <button className="btn primary" onClick={review}>Review and send</button>}
    </div>
  );
}

export function Slots({ slots, title }: { slots: { start: string; end: string }[]; title?: string }) {
  const [made, setMade] = useState<string | null>(null);
  const [name, setName] = useState(title ?? 'Meeting');
  const [err, setErr] = useState<string | null>(null);
  async function create(s: { start: string; end: string }) {
    try { await api('/meetings', { body: { title: name, startsAt: s.start, endsAt: s.end, attendees: [] } }); setMade(`Created "${name}" on ${day(s.start)} ${hm(s.start)}`); } catch (e) { setErr((e as Error).message); }
  }
  if (!slots.length) return <Empty>No free slots in that range.</Empty>;
  return (
    <div>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Meeting title" />
      <div className="chips">{slots.map((s) => <button key={s.start} className="chip btnchip" onClick={() => create(s)}>{day(s.start)} {hm(s.start)}</button>)}</div>
      {made && <p className="ok">{made}</p>}{err && <p className="error">{err}</p>}
    </div>
  );
}

export function Brief({ b }: { b: any }) {
  if (!b) return <Empty>Meeting not found.</Empty>;
  return (
    <div className="brief">
      <h4>{b.meeting.title} <span className="meta">{day(b.meeting.starts_at)} {hm(b.meeting.starts_at)}</span></h4>
      <div className="grid2">
        <div><h5>Participants</h5><ul>{b.participants.map((p: any) => <li key={p.email}>{p.name ?? p.email}{p.company ? ` · ${p.company}` : ''}</li>)}</ul></div>
        <div><h5>Recommended talking points</h5><ul>{b.talkingPoints.map((t: string) => <li key={t}>{t}</li>)}</ul></div>
        <div><h5>Open tasks</h5>{b.openTasks.length ? <ul>{b.openTasks.map((t: any) => <li key={t.id}>{t.title} <span className="meta">{t.status}{t.external_key ? ` · ${t.external_key}` : ''}</span></li>)}</ul> : <Empty>None found</Empty>}</div>
        <div><h5>Previous conversations</h5>{b.recentConversations.length ? <ul>{b.recentConversations.map((m: any) => <li key={m.id}><SourceTag source={m.source} /> {m.subject ?? m.summary} <span className="meta">{when(m.sent_at)}</span></li>)}</ul> : <Empty>None found</Empty>}</div>
        <div><h5>Previous meeting notes</h5>{b.previousNotes.length ? <ul>{b.previousNotes.map((n: any, i: number) => <li key={i}><strong>{n.title}</strong>: {n.summary}</li>)}</ul> : <Empty>None found</Empty>}</div>
        <div><h5>Related documents</h5>{b.documents.length ? <ul>{b.documents.map((d: any) => <li key={d.id}><SourceTag source={d.source} /> {d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a> : d.title}</li>)}</ul> : <Empty>None found</Empty>}</div>
      </div>
    </div>
  );
}

export function ActionItems({ n }: { n: any }) {
  const [made, setMade] = useState<Record<number, string>>({});
  if (!n) return <Empty>No meeting notes found.</Empty>;
  async function create(i: number, a: any) {
    const r = await api<any>('/tasks', { body: { title: a.title, description: `From meeting "${n.title}". Owner: ${a.owner}`, source: 'meeting', sourceRef: n.id, origin: 'ai_extracted' } });
    setMade((m) => ({ ...m, [i]: r.id ? 'Task created' : 'Done' }));
  }
  return (
    <div>
      <p><strong>{n.title}</strong> · {n.summary}</p>
      <h5>Decisions</h5><ul>{n.decisions.map((d: string) => <li key={d}>{d}</li>)}</ul>
      <h5>Action items</h5>
      <ul>{n.action_items.map((a: any, i: number) => <li key={i} className="split"><span>{a.title} <span className="meta">· {a.owner}{a.due ? ` · ${a.due}` : ''}</span></span>{made[i] ? <span className="ok">{made[i]}</span> : <button className="btn small" onClick={() => create(i, a)}>Create task</button>}</li>)}</ul>
    </div>
  );
}

export function Hits({ hits }: { hits: any[] }) {
  if (!hits?.length) return <Empty>Nothing found that you have access to.</Empty>;
  return <ul className="list">{hits.map((h) => <li key={`${h.kind}-${h.id}`} className="row-item"><div className="row-top"><SourceTag source={h.source} /><strong>{h.url ? <a href={h.url} target="_blank" rel="noreferrer">{h.title}</a> : h.title}</strong><span className="meta right">{when(h.at)}</span></div><div className="meta">{h.snippet}</div></li>)}</ul>;
}

export function Timeline({ hits }: { hits: any[] }) {
  if (!hits?.length) return <Empty>No activity found.</Empty>;
  return <ol className="timeline">{hits.map((h) => <li key={`${h.kind}-${h.id}`}><span className="dot" /><div><div className="meta">{day(h.at)} · {h.kind}</div><div><SourceTag source={h.source} /> <strong>{h.title}</strong></div><div className="meta">{h.snippet}</div></div></li>)}</ol>;
}

export function Briefing({ b }: { b: any }) {
  return (
    <div>
      <pre className="greeting">{b.greeting}</pre>
      <div className="grid2">
        <div><h5>Needs attention now</h5>{b.needsAttentionNow.length ? <ul className="list">{b.needsAttentionNow.map((m: any) => <MessageRow key={m.id} m={m} />)}</ul> : <Empty>Nothing urgent.</Empty>}</div>
        <div><h5>Can wait</h5>{b.canWait.length ? <ul className="list">{b.canWait.map((m: any) => <MessageRow key={m.id} m={m} />)}</ul> : <Empty>Clear.</Empty>}</div>
      </div>
      {b.blocked.length > 0 && <><h5>Blocked</h5><ul>{b.blocked.map((t: any) => <li key={t.id}>{t.title} {t.external_key && <span className="meta">{t.external_key}</span>}</li>)}</ul></>}
    </div>
  );
}

export function Suggestions({ items }: { items: any[] }) {
  if (!items?.length) return <Empty>No suggestions right now.</Empty>;
  return <ul className="list">{items.map((s, i) => <li key={i} className="row-item"><strong>{s.title}</strong><div className="meta">Why: {s.rationale}</div></li>)}</ul>;
}

/** Renders one executed supervisor step by tool name. */
export function ToolResult({ tool, output }: { tool: string; output: any }) {
  switch (tool) {
    case 'list_inbox': return output.length ? <ul className="list">{output.map((m: any) => <MessageRow key={m.id} m={m} />)}</ul> : <Empty>Nothing here. You are caught up.</Empty>;
    case 'search_workspace': return <Hits hits={output} />;
    case 'ask_company': return <div><p className="answer">{output.answer}</p><p className="meta">Answered by {output.engine === 'anthropic' ? 'Claude' : 'built-in local engine (free)'} from sources you can access:</p><Hits hits={output.sources} /></div>;
    case 'build_timeline': return <Timeline hits={output} />;
    case 'daily_briefing': return <Briefing b={output} />;
    case 'list_suggestions': return <Suggestions items={output} />;
    case 'find_free_slots': return <Slots slots={output} />;
    case 'suggest_replies': return <ReplyPanel data={output} />;
    case 'compose_draft': return <DraftEditor d={output} />;
    case 'meeting_brief': return <Brief b={output} />;
    case 'meeting_action_items': return <ActionItems n={output} />;
    case 'github_activity': return output.length ? <ul className="list">{output.map((m: any) => <MessageRow key={m.id} m={{ ...m, source: 'github' }} />)}</ul> : <Empty>No matching GitHub activity.</Empty>;
    case 'list_meetings': return output.length ? <ul className="list">{output.map((m: any) => <li key={m.id} className="row-item"><strong>{m.title}</strong> <span className="meta">{day(m.starts_at)} {hm(m.starts_at)}</span> · <Link href={`/meetings?id=${m.id}`}>brief</Link></li>)}</ul> : <Empty>No meetings in that range.</Empty>;
    case 'list_tasks': return output.length ? <ul className="list">{output.map((t: any) => <li key={t.id} className="row-item"><strong>{t.title}</strong> <span className="chip">{t.status}</span>{t.due_at && <span className="meta"> due {day(t.due_at)}</span>}</li>)}</ul> : <Empty>No tasks.</Empty>;
    default: return <pre>{JSON.stringify(output, null, 2)}</pre>;
  }
}
