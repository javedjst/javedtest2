'use client';
import { useState } from 'react';
import { Slots } from '@/components/Results';
import { Card, Empty, ErrorNote, Page, day, hm } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAY = 86_400_000;
const monday = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d; };

export default function Calendar() {
  const [offset, setOffset] = useState(0);
  const from = new Date(monday().getTime() + offset * 7 * DAY);
  const to = new Date(from.getTime() + 7 * DAY);
  const list = useApi<any[]>(`/meetings?from=${from.toISOString()}&to=${to.toISOString()}`);
  const [slots, setSlots] = useState<any[] | null>(null);
  const [dur, setDur] = useState(30);
  const [title, setTitle] = useState('');

  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * DAY));
  const conflicts = new Set<string>();
  const ms = list.data ?? [];
  for (const a of ms) for (const b of ms) if (a.id < b.id && new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)) { conflicts.add(a.id); conflicts.add(b.id); }

  return (
    <Page title="Calendar" subtitle="Your week, conflicts highlighted. Free slots avoid existing meetings." actions={<div className="row"><button className="btn" onClick={() => setOffset(offset - 1)}>Previous</button><button className="btn" onClick={() => setOffset(0)}>This week</button><button className="btn" onClick={() => setOffset(offset + 1)}>Next</button></div>}>
      <ErrorNote message={list.error} />
      <div className="grid">
        <Card title={`${day(from.toISOString())} – ${day(new Date(to.getTime() - DAY).toISOString())}`}>
          {days.map((d) => {
            const items = ms.filter((m) => new Date(m.starts_at).toDateString() === d.toDateString());
            return <div key={d.toISOString()}><h5>{day(d.toISOString())}</h5>{items.length ? <ul className="list">{items.map((m) => <li key={m.id} className="row-item"><strong>{m.title}</strong> {conflicts.has(m.id) && <span className="badge p-urgent">conflict</span>}<div className="meta">{hm(m.starts_at)} – {hm(m.ends_at)} · {m.provider ?? 'local'}{m.participants?.length ? ` · ${m.participants.length} people` : ''}</div></li>)}</ul> : <Empty>Free</Empty>}</div>;
          })}
        </Card>
        <Card title="Find a time">
          <div className="row"><label className="meta">Length <select style={{ width: 'auto' }} value={dur} onChange={(e) => setDur(+e.target.value)}>{[15, 30, 45, 60, 90].map((n) => <option key={n} value={n}>{n} min</option>)}</select></label></div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title" aria-label="Meeting title" style={{ margin: '8px 0' }} />
          <button className="btn" onClick={async () => setSlots(await api<any[]>('/meetings/free-slots', { body: { durationMin: dur, from: new Date(Math.max(Date.now(), from.getTime())).toISOString(), to: to.toISOString() } }))}>Suggest times</button>
          {slots && <Slots slots={slots} title={title || 'Meeting'} />}
          <p className="meta">Events are stored in the hub. Invites and video links go out once Google Calendar is connected (adapter planned).</p>
        </Card>
      </div>
    </Page>
  );
}
