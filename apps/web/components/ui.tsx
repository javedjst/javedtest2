import type { ReactNode } from 'react';

const SOURCE_LABEL: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', github: 'GitHub', jira: 'Jira', confluence: 'Confluence', gdrive: 'Drive', calendar: 'Calendar', tasks: 'Tasks', whatsapp: 'WhatsApp', teams: 'Teams', outlook: 'Outlook' };

export const SourceTag = ({ source }: { source: string }) => <span className={`tag src-${source}`}>{SOURCE_LABEL[source] ?? source}</span>;
export const Priority = ({ p }: { p?: string | null }) => (p ? <span className={`badge p-${p}`}>{p}</span> : null);

export function Card({ title, action, children, id }: { title?: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {(title || action) && <header className="card-h"><h3>{title}</h3>{action}</header>}
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
export const ErrorNote = ({ message }: { message: string | null }) => (message ? <p className="error" role="alert">{message}</p> : null);

export function when(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const text = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}
export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const hm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function Page({ title, subtitle, children, actions }: { title: string; subtitle?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page">
      <div className="page-h"><div><h1>{title}</h1>{subtitle && <p className="sub">{subtitle}</p>}</div>{actions}</div>
      {children}
    </div>
  );
}
