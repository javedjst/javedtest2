'use client';
import { useState } from 'react';
import { api, type Pending } from '@/lib/api';

export interface ApprovalLike { id?: string; approvalId?: string; tool: string; risk: string; preview: Pending['preview'] }

/** Shows exactly what will happen. For messages the body is editable, and the edited text is what is sent. */
export function ApprovalCard({ approval, onDone }: { approval: ApprovalLike; onDone: (outcome: 'approved' | 'rejected', result?: unknown) => void }) {
  const id = approval.id ?? approval.approvalId!;
  const input = approval.preview.input as { body?: string; to?: string[]; subject?: string; channel?: string };
  const [body, setBody] = useState(input.body ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isMsg = approval.tool === 'send_message';

  async function decide(action: 'approve' | 'reject') {
    setBusy(true); setErr(null);
    try {
      const res = await api<{ status: string; error?: string }>(`/approvals/${id}/${action}`, { body: action === 'approve' && isMsg && body !== input.body ? { input: { ...approval.preview.input, body } } : {} });
      if (res.status === 'failed') throw new Error(res.error ?? 'Action failed');
      onDone(action === 'approve' ? 'approved' : 'rejected', res);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="approval">
      <div className="approval-h"><strong>{approval.preview.description}</strong><span className={`badge risk-${approval.risk}`}>{approval.risk} risk</span></div>
      {isMsg ? (
        <>
          <p className="meta">{input.channel} to {input.to?.join(', ')}{input.subject ? ` · ${input.subject}` : ''}</p>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(12, Math.max(4, body.split('\n').length + 1))} aria-label="Message body" />
        </>
      ) : <pre>{JSON.stringify(approval.preview.input, null, 2)}</pre>}
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => decide('approve')}>{isMsg ? 'Approve and send' : 'Approve and run'}</button>
        <button className="btn" disabled={busy} onClick={() => decide('reject')}>Reject</button>
        <span className="meta">Nothing happens until you approve.</span>
      </div>
    </div>
  );
}
