'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ActionItems, Brief } from '@/components/Results';
import { Card, Empty, ErrorNote, Page, day, hm } from '@/components/ui';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
function Meetings() {
  const params = useSearchParams();
  const [id, setId] = useState<string | null>(params.get('id'));
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const list = useApi<any[]>(`/meetings?from=${from}&to=${to}`);
  const brief = useApi<any>(id ? `/meetings/${id}/brief` : null);
  const notes = useApi<any>(id ? `/meetings/${id}/notes` : null);
  const upcoming = (list.data ?? []).filter((m) => new Date(m.ends_at) > new Date());
  const past = (list.data ?? []).filter((m) => new Date(m.ends_at) <= new Date()).reverse();
  const Item = ({ m }: { m: any }) => <li className={`row-item`} role="button" tabIndex={0} onClick={() => setId(m.id)} onKeyDown={(e) => e.key === 'Enter' && setId(m.id)}><strong>{m.title}</strong><div className="meta">{day(m.starts_at)} {hm(m.starts_at)} · {m.participants?.length ?? 0} people</div></li>;
  return (
    <Page title="Meetings" subtitle="Pre-meeting briefs and post-meeting notes.">
      <ErrorNote message={list.error} />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(280px,1fr) minmax(360px,2fr)' }}>
        <div>
          <Card title="Upcoming">{upcoming.length ? <ul className="list">{upcoming.map((m) => <Item key={m.id} m={m} />)}</ul> : <Empty>None.</Empty>}</Card>
          <Card title="Past">{past.length ? <ul className="list">{past.map((m) => <Item key={m.id} m={m} />)}</ul> : <Empty>None.</Empty>}</Card>
        </div>
        <div>
          {!id && <Card><Empty>Select a meeting to see its brief.</Empty></Card>}
          {id && <Card title="Meeting brief">{brief.loading ? <Empty>Preparing…</Empty> : <Brief b={brief.data} />}<ErrorNote message={brief.error} /></Card>}
          {id && notes.data && <Card title="Notes, decisions and action items"><ActionItems n={notes.data} /><p className="meta">Transcripts come from Google Meet or Teams once those integrations are connected. Follow-up emails are drafted from the notes and sent only after you approve them.</p></Card>}
        </div>
      </div>
    </Page>
  );
}
export default function MeetingsPage() { return <Suspense><Meetings /></Suspense>; }
