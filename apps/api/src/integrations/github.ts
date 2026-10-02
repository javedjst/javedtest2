import { config } from '../config.js';
import { json, request } from './http.js';
import type { AdapterContext, IntegrationAdapter, NormalizedMessage, SearchHit, SyncResult } from './types.js';

const API = 'https://api.github.com';

const gh = (ctx: AdapterContext, path: string, init: RequestInit = {}) =>
  request(`${API}${path}`, { ...init, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${ctx.credentials.accessToken}`, ...(init.headers ?? {}) } });

interface Notification { id: string; reason: string; updated_at: string; subject: { title: string; url: string; type: string }; repository: { full_name: string; private: boolean } }

/** Review requests, mentions, assignments and CI activity arrive as GitHub notifications. */
export const githubAdapter: IntegrationAdapter = {
  provider: 'github',
  displayName: 'GitHub',
  category: 'code',
  status: 'ready',
  supports: ['connect', 'sync', 'search', 'create', 'permissions'],
  oauth: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user', 'notifications'],
  },

  async connect({ code, redirectUri, codeVerifier }) {
    const res = await request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
    });
    const t = await json<{ access_token: string; scope: string }>(res);
    const me = await json<{ login: string }>(await request(`${API}/user`, { headers: { authorization: `Bearer ${t.access_token}`, accept: 'application/vnd.github+json' } }));
    return { credentials: { accessToken: t.access_token }, externalAccount: me.login, scopes: t.scope.split(',') };
  },

  async sync(ctx, cursor): Promise<SyncResult> {
    const since = cursor ? `&since=${encodeURIComponent(cursor)}` : '';
    const res = await gh(ctx, `/notifications?all=false&per_page=50${since}`);
    const list = await json<Notification[]>(res);
    const allowed = ctx.config.allowedRepos as string[] | undefined;   // admin restriction on sensitive repos
    const messages: NormalizedMessage[] = list
      .filter((n) => !allowed || allowed.includes(n.repository.full_name))
      .map((n) => ({
        externalId: n.id,
        source: 'github',
        kind: n.reason === 'review_requested' ? 'approval' : n.reason === 'mention' ? 'mention' : 'notification',
        senderName: n.repository.full_name,
        subject: `${n.subject.type}: ${n.subject.title}`,
        body: `${n.reason.replace('_', ' ')} on ${n.repository.full_name}: ${n.subject.title}`,
        sentAt: new Date(n.updated_at),
        direction: 'inbound',
        acl: [`repo:${n.repository.full_name}`],
      }));
    return { messages, documents: [], events: [], nextCursor: new Date().toISOString() };
  },

  async search(ctx, query): Promise<SearchHit[]> {
    const r = await json<{ items: { number: number; title: string; html_url: string; body?: string }[] }>(await gh(ctx, `/search/issues?per_page=10&q=${encodeURIComponent(query)}`));
    return r.items.map((i) => ({ externalId: String(i.number), title: i.title, snippet: (i.body ?? '').slice(0, 200), url: i.html_url }));
  },

  async create(ctx, kind, input) {
    if (kind !== 'issue') throw new Error(`github.create supports kind=issue, got ${kind}`);
    const r = await json<{ number: number; html_url: string }>(await gh(ctx, `/repos/${String(input.repo)}/issues`, { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body }) }));
    return { externalId: String(r.number), url: r.html_url };
  },

  async permissions(ctx, repo) {
    const r = await json<{ permissions?: Record<string, boolean> }>(await gh(ctx, `/repos/${repo}`));
    return Object.entries(r.permissions ?? {}).filter(([, v]) => v).map(([k]) => `repo:${repo}:${k}`);
  },
};
