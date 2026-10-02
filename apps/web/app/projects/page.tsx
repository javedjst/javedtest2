'use client';
import { useState } from 'react';
import { Timeline } from '@/components/Results';
import { Card, ErrorNote, Page } from '@/components/ui';
import { api } from '@/lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Projects() {
  const [subject, setSubject] = useState('Cleartrip');
  const [hits, setHits] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(s = subject) { setErr(null); try { setHits(await api<any[]>(`/timeline?subject=${encodeURIComponent(s)}`)); } catch (e) { setErr((e as Error).message); } }
  return (
    <Page title="Projects and clients" subtitle="One timeline per person, project or company: mail, chat, documents, tickets and meetings together.">
      <Card>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Client, project or person" aria-label="Subject" style={{ flex: 1 }} />
          <button className="btn primary">Build timeline</button>
        </form>
        <div className="chips">{['Cleartrip', 'Northwind', 'payments deploy', 'API migration'].map((s) => <button key={s} className="chip btnchip" onClick={() => { setSubject(s); void go(s); }}>{s}</button>)}</div>
      </Card>
      <ErrorNote message={err} />
      {hits && <Card title={`Timeline: ${subject}`}><Timeline hits={hits} /></Card>}
    </Page>
  );
}
