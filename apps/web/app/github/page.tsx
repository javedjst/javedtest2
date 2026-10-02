'use client';
import { useState } from 'react';
import { MessageRow } from '@/components/Results';
import { Card, Empty, ErrorNote, Page } from '@/components/ui';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function GitHub() {
  const [kind, setKind] = useState('all');
  const [days, setDays] = useState(7);
  const list = useApi<any[]>(`/github/activity?kind=${kind}&days=${days}`);
  return (
    <Page title="GitHub" subtitle="Review requests, CI and deployment failures, security alerts, mentions.">
      <div className="tabs">{[['all', 'Everything'], ['reviews', 'Reviews waiting'], ['ci', 'CI and deploys'], ['security', 'Security alerts']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k!)}>{l}</button>)}
        <select style={{ width: 'auto' }} value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Range">{[1, 3, 7, 30].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select></div>
      <ErrorNote message={list.error} />
      <Card>{list.data?.length ? <ul className="list">{list.data.map((m) => <MessageRow key={m.id} m={{ ...m, source: 'github' }} />)}</ul> : <Empty>No matching activity.</Empty>}</Card>
      <p className="meta">Shows what the GitHub adapter has synced. You can also ask in plain language from the AI Assistant, for example “Which pull requests are waiting for me?”.</p>
    </Page>
  );
}
