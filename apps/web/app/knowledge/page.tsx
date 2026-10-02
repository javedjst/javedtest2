'use client';
import { useState } from 'react';
import { ToolResult } from '@/components/Results';
import { Card, ErrorNote, Page } from '@/components/ui';
import { api } from '@/lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Knowledge() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask(text = q) {
    setBusy(true); setErr(null);
    try { setRes(await api('/ask', { body: { question: text } })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Page title="Knowledge" subtitle="Ask your company anything. Answers cite their sources and only use what you are allowed to see.">
      <Card>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="What is our incident response process?" aria-label="Question" style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || q.trim().length < 2}>Ask</button>
        </form>
        <div className="chips">{['What is our incident response process?', 'Find the latest AWS architecture document', 'What did we decide about the API migration?', 'Show our endpoint security policy'].map((x) => <button key={x} className="chip btnchip" onClick={() => { setQ(x); void ask(x); }}>{x}</button>)}</div>
      </Card>
      <ErrorNote message={err} />
      {res && <Card title="Answer"><ToolResult tool="ask_company" output={res} /></Card>}
    </Page>
  );
}
