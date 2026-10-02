'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalCard } from '@/components/ApprovalCard';
import { DraftEditor, ToolResult } from '@/components/Results';
import { Card, ErrorNote, Page } from '@/components/ui';
import { api } from '@/lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EXAMPLES = ['Show everything I need to reply to', "Summarise today's work", 'Schedule a meeting with Kartik next week', 'Find the AWS security document', 'Reply to the latest Cleartrip email', "Create Jira tasks from today's meeting", 'Show GitHub production issues', 'Prepare my meetings for tomorrow', 'What happened with the Cleartrip security assessment?', 'What is our incident response process?'];

function Assistant() {
  const params = useSearchParams();
  const [text, setText] = useState('');
  const [runs, setRuns] = useState<{ q: string; res?: any; err?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState('');
  const [draft, setDraft] = useState<any | null>(null);
  const started = useRef<string | null>(null);

  const run = useCallback(async (q: string) => {
    setBusy(true);
    setRuns((r) => [{ q }, ...r]);
    try {
      const res = await api<any>('/command', { body: { text: q } });
      setRuns((r) => r.map((x, i) => (i === 0 ? { ...x, res } : x)));
    } catch (e) { setRuns((r) => r.map((x, i) => (i === 0 ? { ...x, err: (e as Error).message } : x))); } finally { setBusy(false); }
  }, []);

  useEffect(() => { const q = params.get('q'); if (q && started.current !== q) { started.current = q; void run(q); } }, [params, run]);

  return (
    <Page title="AI Assistant" subtitle="Ask a question, give a command, or write a message. Actions that change things outside this app always ask first.">
      <Card title="Command">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void run(text.trim()); setText(''); } }} className="row">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you need?" aria-label="Command" style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy}>Run</button>
        </form>
        <div className="chips">{EXAMPLES.map((x) => <button key={x} className="chip btnchip" onClick={() => run(x)}>{x}</button>)}</div>
      </Card>

      <Card title="Universal composer">
        <p className="meta">Describe the message. Example: “Write an email to the engineering team about today's deployment delay.”</p>
        <textarea value={composer} onChange={(e) => setComposer(e.target.value)} rows={3} placeholder="Reply to Rahul and tell him we'll share the report tomorrow" aria-label="Composer instruction" />
        <button className="btn" disabled={!composer.trim()} onClick={async () => setDraft(await api('/compose', { body: { instruction: composer } }))}>Draft it</button>
        {draft && <DraftEditor key={JSON.stringify(draft)} d={draft} />}
      </Card>

      {runs.map((r, i) => (
        <Card key={i} title={r.q} action={r.res && <span className="meta">{r.res.intent} · agents: {r.res.agents.join(', ')}</span>}>
          {!r.res && !r.err && <p className="empty">Working…</p>}
          <ErrorNote message={r.err ?? null} />
          {r.res && <p className="meta">{r.res.explanation}</p>}
          {r.res?.steps.map((s: any, j: number) => (
            <div key={j}>
              {s.result.status === 'executed' && <ToolResult tool={s.tool} output={s.result.output} />}
              {s.result.status === 'pending_approval' && <ApprovalCard approval={s.result} onDone={() => undefined} />}
              {s.result.status === 'denied' && <p className="error">Blocked by policy: {s.result.reason}</p>}
              {s.result.status === 'failed' && <p className="error">{s.tool} failed: {s.result.error}</p>}
            </div>
          ))}
        </Card>
      ))}
    </Page>
  );
}

export default function Page_() { return <Suspense><Assistant /></Suspense>; }
