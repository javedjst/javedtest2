'use client';
import Link from 'next/link';
import { ApprovalCard } from '@/components/ApprovalCard';
import { Brief, Briefing, MessageRow, Suggestions } from '@/components/Results';
import { Card, Empty, ErrorNote, Page, day, hm } from '@/components/ui';
import { useMe } from '@/components/Shell';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Home() {
  const me = useMe();
  const brief = useApi<any>('/briefing');
  const replies = useApi<any[]>('/inbox?filter=needs_reply&limit=5');
  const waiting = useApi<any[]>('/inbox?filter=waiting&limit=5');
  const sugg = useApi<any[]>('/suggestions');
  const approvals = useApi<any[]>('/approvals');
  const gh = useApi<any[]>('/github/activity?kind=all&days=7');
  const tasks = useApi<any[]>('/tasks?status=open');
  const from = new Date(); from.setUTCHours(0, 0, 0, 0);
  const meetings = useApi<any[]>(`/meetings?from=${from.toISOString()}&to=${new Date(from.getTime() + 2 * 86_400_000).toISOString()}`);

  return (
    <Page title={`Welcome, ${me.name.split(' ')[0]}`} subtitle="Everything that needs you, from every connected app.">
      {approvals.data && approvals.data.length > 0 && (
        <Card title="Waiting for your approval" id="approvals">
          {approvals.data.map((a) => <ApprovalCard key={a.id} approval={a} onDone={() => approvals.reload()} />)}
        </Card>
      )}
      <div className="grid" style={{ marginTop: 16 }}>
        <Card title="Today's briefing">{brief.data ? <Briefing b={brief.data} /> : <ErrorNote message={brief.error} />}</Card>
        <Card title="AI suggestions" action={<span className="meta">each one says why</span>}>{sugg.data ? <Suggestions items={sugg.data} /> : <ErrorNote message={sugg.error} />}</Card>
        <Card title="Needs your reply" action={<Link href="/inbox">Open inbox</Link>}>
          {replies.data?.length ? <ul className="list">{replies.data.map((m) => <MessageRow key={m.id} m={m} />)}</ul> : <Empty>Nothing waiting.</Empty>}
        </Card>
        <Card title="Upcoming meetings" action={<Link href="/meetings">All</Link>}>
          {meetings.data?.length ? <ul className="list">{meetings.data.map((m) => <li key={m.id} className="row-item"><strong>{m.title}</strong><div className="meta">{day(m.starts_at)} {hm(m.starts_at)} – {hm(m.ends_at)} · {(m.participants ?? []).length} people · <Link href={`/meetings?id=${m.id}`}>brief</Link></div></li>)}</ul> : <Empty>No meetings.</Empty>}
        </Card>
        <Card title="Priority tasks" action={<Link href="/tasks">All</Link>}>
          {tasks.data?.length ? <ul className="list">{tasks.data.slice(0, 6).map((t) => <li key={t.id} className="row-item"><strong>{t.title}</strong> {t.external_key && <span className="chip">{t.external_key}</span>}<div className="meta">{t.due_at ? `Due ${day(t.due_at)}` : 'No due date'} · {t.origin.replace('_', ' ')}</div></li>)}</ul> : <Empty>No open tasks.</Empty>}
        </Card>
        <Card title="Waiting for response">
          {waiting.data?.length ? <ul className="list">{waiting.data.map((m) => <MessageRow key={m.id} m={m} />)}</ul> : <Empty>Nobody owes you a reply.</Empty>}
        </Card>
        <Card title="GitHub activity" action={<Link href="/github">Open</Link>}>
          {gh.data?.length ? <ul className="list">{gh.data.slice(0, 5).map((m) => <MessageRow key={m.id} m={{ ...m, source: 'github' }} />)}</ul> : <Empty>Quiet.</Empty>}
        </Card>
      </div>
    </Page>
  );
}
