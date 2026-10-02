'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';

export interface Me { userId: string; name: string; email: string; role: 'owner' | 'admin' | 'member' | 'viewer'; aiMode: 'anthropic' | 'local' }
const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;

const NAV: [string, string][] = [
  ['/', 'Home'], ['/inbox', 'Inbox'], ['/assistant', 'AI Assistant'], ['/calendar', 'Calendar'], ['/meetings', 'Meetings'], ['/tasks', 'Tasks'],
  ['/projects', 'Projects'], ['/github', 'GitHub'], ['/jira', 'Jira'], ['/knowledge', 'Knowledge'], ['/integrations', 'Integrations'], ['/automations', 'Automations'], ['/admin', 'Admin'],
];
const DEMO_USERS = [['javed@acme.test', 'Javed Khan', 'owner'], ['priya@acme.test', 'Priya Nair', 'admin'], ['sam@acme.test', 'Sam Lee', 'member']];

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [pending, setPending] = useState(0);
  const [q, setQ] = useState('');
  const path = usePathname();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setMe(await api<Me>('/me')); setState('in'); } catch (e) { setState(e instanceof ApiError && e.status === 401 ? 'out' : 'out'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (state === 'in') api<unknown[]>('/approvals').then((a) => setPending(a.length)).catch(() => undefined); }, [state, path]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (state === 'loading') return <div className="center">Loading…</div>;
  if (state === 'out') return <Login onDone={load} />;

  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <nav className="side" aria-label="Main">
          <div className="brand">AI Work Hub</div>
          {NAV.filter(([href]) => href !== '/admin' || me!.role === 'owner' || me!.role === 'admin').map(([href, label]) => (
            <Link key={href} href={href} className={(href === '/' ? path === '/' : path.startsWith(href)) ? 'active' : ''}>{label}</Link>
          ))}
          <div className="side-foot">
            <div className="meta">{me!.name} · {me!.role}</div>
            <div className="meta">AI: {me!.aiMode === 'anthropic' ? 'Claude' : 'local engine (free)'}</div>
            <button className="linkbtn" onClick={async () => { await api('/auth/logout', { method: 'POST', body: {} }); setState('out'); }}>Sign out</button>
          </div>
        </nav>
        <div className="main">
          <header className="top">
            <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) { router.push(`/assistant?q=${encodeURIComponent(q.trim())}`); setQ(''); } }}>
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask your company anything, or give a command…  (Ctrl+K)" aria-label="Command bar" />
            </form>
            <Link href="/#approvals" className={`pill ${pending ? 'alert' : ''}`}>{pending} awaiting approval</Link>
          </header>
          {children}
        </div>
      </div>
    </MeContext.Provider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function go(email: string) {
    try { await api('/auth/dev-login', { body: { email } }); onDone(); } catch (e) { setErr((e as Error).message === 'Not found' ? 'Development sign-in is disabled. Use your company SSO.' : (e as Error).message); }
  }
  return (
    <div className="center">
      <div className="card login">
        <h1>AI Work Hub</h1>
        <p className="sub">One place for your mail, chat, code, tickets and meetings.</p>
        <p className="meta">Development sign-in (needs DEV_AUTH=true and the seeded demo data):</p>
        {DEMO_USERS.map(([email, name, role]) => <button key={email} className="btn" onClick={() => go(email!)}>{name} <span className="meta">{role}</span></button>)}
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}
