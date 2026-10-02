'use client';
import { useState } from 'react';
import { Card, ErrorNote, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Integrations() {
  const list = useApi<{ catalog: any[] }>('/integrations');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function connect(p: string) {
    setErr(null);
    try { const { url } = await api<{ url: string }>(`/integrations/${p}/start`); window.location.href = url; } catch (e) { setErr((e as Error).message); }
  }
  async function sync(id: string) {
    setErr(null); setMsg('Syncing…');
    try { const r = await api<any>(`/integrations/${id}/sync`, { body: {} }); setMsg(`Synced ${r.messages} new messages and ${r.documents} documents.`); list.reload(); } catch (e) { setMsg(null); setErr((e as Error).message); }
  }
  async function disconnect(id: string) { await api(`/integrations/${id}`, { method: 'DELETE' }); list.reload(); }
  return (
    <Page title="Integrations" subtitle="Each connector declares what it can do. Tokens are encrypted and never shown to the AI.">
      <ErrorNote message={err ?? list.error} />{msg && <p className="ok">{msg}</p>}
      <div className="grid">
        {list.data?.catalog.map((c) => (
          <Card key={c.provider} title={c.name} action={<span className={`badge ${c.status === 'ready' ? 'risk-low' : ''}`}>{c.status === 'ready' ? 'available' : 'planned'}</span>}>
            <p className="meta">{c.category} · supports: {c.supports.join(', ')}</p>
            {c.connections.map((x: any) => (
              <div key={x.id} className="split"><span>{x.external_account ?? 'connected'} <span className="meta">· {x.status}{x.last_error ? ` · ${x.last_error}` : ''}</span></span>
                <span className="row"><button className="btn small" onClick={() => sync(x.id)}>Sync now</button><button className="btn small" onClick={() => disconnect(x.id)}>Disconnect</button></span></div>
            ))}
            {c.status === 'ready' && <button className="btn" onClick={() => connect(c.provider)} disabled={!c.configured} title={c.configured ? '' : 'Set the OAuth client id and secret in the API environment'}>{c.connections.length ? 'Connect another account' : 'Connect'}</button>}
            {c.status === 'ready' && !c.configured && <p className="meta">OAuth client not configured on the server.</p>}
          </Card>
        ))}
      </div>
    </Page>
  );
}
