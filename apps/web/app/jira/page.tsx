'use client';
import { MessageRow } from '@/components/Results';
import { Card, Empty, Page } from '@/components/ui';
import { useApi } from '@/lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Jira() {
  const inbox = useApi<any[]>('/inbox?source=jira&limit=30');
  const blocked = useApi<any[]>('/tasks?status=blocked');
  const overdue = useApi<any[]>('/tasks?status=overdue');
  const cat = useApi<{ catalog: any[] }>('/integrations');
  const jira = cat.data?.catalog.find((c) => c.provider === 'jira');
  return (
    <Page title="Jira" subtitle="Assigned issues, blockers and overdue work.">
      {jira?.status === 'planned' && <Card><p><strong>The Jira connector is not built yet.</strong> It will support: {jira.supports.join(', ')}. Until then this page shows Jira items that reached the hub as notifications, and tasks that carry a Jira key.</p></Card>}
      <div className="grid" style={{ marginTop: 16 }}>
        <Card title="Notifications">{inbox.data?.length ? <ul className="list">{inbox.data.map((m) => <MessageRow key={m.id} m={m} />)}</ul> : <Empty>None.</Empty>}</Card>
        <Card title="Blockers">{blocked.data?.length ? <ul className="list">{blocked.data.map((t) => <li key={t.id} className="row-item"><strong>{t.title}</strong> {t.external_key && <span className="chip">{t.external_key}</span>}</li>)}</ul> : <Empty>No blockers.</Empty>}</Card>
        <Card title="Overdue">{overdue.data?.length ? <ul className="list">{overdue.data.map((t) => <li key={t.id} className="row-item"><strong>{t.title}</strong> {t.external_key && <span className="chip">{t.external_key}</span>}</li>)}</ul> : <Empty>Nothing overdue.</Empty>}</Card>
      </div>
    </Page>
  );
}
