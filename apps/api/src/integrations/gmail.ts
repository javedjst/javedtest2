import { json, request } from './http.js';
import { config } from '../config.js';
import type { AdapterContext, Credentials, IntegrationAdapter, NormalizedMessage, SearchHit, SendRequest, SyncResult } from './types.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }
interface GmailMessage { id: string; threadId: string; internalDate: string; labelIds?: string[]; payload?: GmailPart & { headers?: GmailHeader[] } }

async function authed(ctx: AdapterContext, path: string, init: RequestInit = {}): Promise<Response> {
  const run = (token: string) => request(`${API}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  let res = await run(ctx.credentials.accessToken);
  if (res.status === 401 && ctx.credentials.refreshToken) {
    const next = await refresh(ctx.credentials.refreshToken);
    ctx.credentials = next;
    await ctx.onTokenRefresh(next);
    res = await run(next.accessToken);
  }
  return res;
}

export async function refresh(refreshToken: string): Promise<Credentials> {
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID ?? '', client_secret: config.GOOGLE_CLIENT_SECRET ?? '', refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const t = await json<{ access_token: string; expires_in: number }>(res);
  return { accessToken: t.access_token, refreshToken, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
}

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;

function extractText(part?: GmailPart): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const p of part.parts ?? []) {
    const t = extractText(p);
    if (t) return t;
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

export function parseFrom(from: string | undefined): { name?: string; address?: string } {
  if (!from) return {};
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1]?.trim() || undefined, address: m[2]!.trim().toLowerCase() } : { address: from.trim().toLowerCase() };
}

export function normalize(m: GmailMessage, ownerEmail: string): NormalizedMessage {
  const from = parseFrom(header(m, 'from'));
  return {
    externalId: m.id,
    threadExternalId: m.threadId,
    source: 'gmail',
    kind: 'message',
    senderName: from.name,
    senderAddress: from.address,
    subject: header(m, 'subject'),
    body: extractText(m.payload).slice(0, 20_000),
    sentAt: new Date(Number(m.internalDate)),
    direction: from.address === ownerEmail.toLowerCase() || m.labelIds?.includes('SENT') ? 'outbound' : 'inbound',
    acl: [`mailbox:${ownerEmail.toLowerCase()}`],
  };
}

export const gmailAdapter: IntegrationAdapter = {
  provider: 'gmail',
  displayName: 'Gmail',
  category: 'email',
  status: 'ready',
  supports: ['connect', 'disconnect', 'sync', 'search', 'read', 'send', 'subscribe'],
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'openid', 'email'],
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },

  async connect({ code, redirectUri, codeVerifier }) {
    const res = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: config.GOOGLE_CLIENT_ID ?? '', client_secret: config.GOOGLE_CLIENT_SECRET ?? '', grant_type: 'authorization_code' }),
    });
    const t = await json<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(res);
    const profile = await json<{ emailAddress: string }>(await request(`${API}/profile`, { headers: { authorization: `Bearer ${t.access_token}` } }));
    return {
      credentials: { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) },
      externalAccount: profile.emailAddress,
      scopes: t.scope.split(' '),
    };
  },

  async disconnect(ctx) {
    await request(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(ctx.credentials.refreshToken ?? ctx.credentials.accessToken)}`, { method: 'POST' }).catch(() => undefined);
  },

  /** Incremental: first run lists recent inbox mail, later runs use history.list from the stored historyId. */
  async sync(ctx, cursor): Promise<SyncResult> {
    const owner = String(ctx.config.email ?? '');
    const ids = new Set<string>();
    let next = cursor;
    if (cursor) {
      const res = await authed(ctx, `/history?startHistoryId=${encodeURIComponent(cursor)}&historyTypes=messageAdded&maxResults=100`);
      if (res.status === 404) return gmailAdapter.sync!(ctx, null); // historyId expired, do a full resync
      const h = await json<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId?: string }>(res);
      for (const x of h.history ?? []) for (const a of x.messagesAdded ?? []) ids.add(a.message.id);
      next = h.historyId ?? cursor;
    } else {
      const l = await json<{ messages?: { id: string }[] }>(await authed(ctx, '/messages?maxResults=50&q=newer_than:14d'));
      for (const m of l.messages ?? []) ids.add(m.id);
      next = (await json<{ historyId: string }>(await authed(ctx, '/profile'))).historyId;
    }
    const messages: NormalizedMessage[] = [];
    for (const id of ids) {
      const res = await authed(ctx, `/messages/${id}?format=full`);
      if (res.status === 404) continue;
      messages.push(normalize(await json<GmailMessage>(res), owner));
    }
    return { messages, documents: [], events: [], nextCursor: next };
  },

  async search(ctx, query): Promise<SearchHit[]> {
    const l = await json<{ messages?: { id: string }[] }>(await authed(ctx, `/messages?maxResults=10&q=${encodeURIComponent(query)}`));
    const hits: SearchHit[] = [];
    for (const { id } of l.messages ?? []) {
      const m = await json<GmailMessage & { snippet?: string }>(await authed(ctx, `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`));
      hits.push({ externalId: id, title: header(m, 'subject') ?? '(no subject)', snippet: m.snippet ?? '', url: `https://mail.google.com/mail/u/0/#all/${m.threadId}` });
    }
    return hits;
  },

  async read(ctx, externalId) {
    const res = await authed(ctx, `/messages/${externalId}?format=full`);
    return res.ok ? normalize(await json<GmailMessage>(res), String(ctx.config.email ?? '')) : null;
  },

  async send(ctx, req: SendRequest) {
    const lines = [`To: ${req.to.join(', ')}`, `Subject: ${(req.subject ?? '').replace(/[\r\n]+/g, ' ')}`, 'Content-Type: text/plain; charset=UTF-8', 'MIME-Version: 1.0', '', req.body];
    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
    const res = await authed(ctx, '/messages/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw, threadId: req.threadExternalId }) });
    return { externalId: (await json<{ id: string }>(res)).id };
  },

  /** Gmail push needs a Pub/Sub topic. Watches expire after 7 days; a scheduled job renews them. */
  async subscribe(ctx, callbackUrl) {
    const topic = String(ctx.config.pubsubTopic ?? '');
    if (!topic) throw new Error(`Set config.pubsubTopic to receive push notifications (callback ${callbackUrl})`);
    const res = await authed(ctx, '/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topicName: topic, labelIds: ['INBOX'] }) });
    const w = await json<{ historyId: string; expiration: string }>(res);
    return { externalId: w.historyId, expiresAt: new Date(Number(w.expiration)) };
  },
};
