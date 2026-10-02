/**
 * Integration adapter contract. Every connector implements this and declares which operations it
 * supports, so the UI, the agents and the admin console can reason about capabilities without
 * special casing providers. Adding Teams, Outlook or Zoom later means adding one adapter file and
 * registering it. Nothing else changes.
 */

export type Operation = 'connect' | 'disconnect' | 'sync' | 'search' | 'read' | 'create' | 'update' | 'send' | 'subscribe' | 'permissions';

export interface NormalizedMessage {
  externalId: string;
  threadExternalId?: string;
  source: string;
  kind: 'message' | 'notification' | 'approval' | 'mention' | 'comment';
  senderName?: string;
  senderAddress?: string;
  subject?: string;
  body: string;
  sentAt: Date;
  direction: 'inbound' | 'outbound';
  /** Principals that may read this item in the source system. Drives permission-aware retrieval. */
  acl: string[];
}

export interface NormalizedDocument {
  externalId: string;
  source: string;
  title: string;
  url?: string;
  body: string;
  updatedAt: Date;
  acl: string[];
}

export interface NormalizedEvent {
  externalId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  attendees: { email: string; response?: string }[];
  meetingUrl?: string;
  provider?: string;
}

export interface SyncResult {
  messages: NormalizedMessage[];
  documents: NormalizedDocument[];
  events: NormalizedEvent[];
  nextCursor: string | null;
}

/** Short lived, decrypted credentials. Exists only inside backend adapter calls, never serialised to a model. */
export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface AdapterContext {
  integrationId: string;
  orgId: string;
  userId: string | null;
  credentials: Credentials;
  config: Record<string, unknown>;
  /** Called by the adapter after a token refresh so the new token is persisted (encrypted). */
  onTokenRefresh(next: Credentials): Promise<void>;
}

export interface SendRequest { to: string[]; subject?: string; body: string; threadExternalId?: string; channel?: string }
export interface SearchHit { externalId: string; title: string; snippet: string; url?: string }

export interface OAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}

export interface IntegrationAdapter {
  readonly provider: string;
  readonly displayName: string;
  readonly category: 'email' | 'calendar' | 'chat' | 'code' | 'tickets' | 'knowledge';
  /** Declared capabilities. Calling an undeclared operation is rejected before it reaches the adapter. */
  readonly supports: readonly Operation[];
  /** Whether a real, tested implementation exists in this build. */
  readonly status: 'ready' | 'planned';
  readonly oauth?: OAuthConfig;

  connect?(ctx: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ credentials: Credentials; externalAccount: string; scopes: string[] }>;
  disconnect?(ctx: AdapterContext): Promise<void>;
  sync?(ctx: AdapterContext, cursor: string | null): Promise<SyncResult>;
  search?(ctx: AdapterContext, query: string): Promise<SearchHit[]>;
  read?(ctx: AdapterContext, externalId: string): Promise<NormalizedMessage | NormalizedDocument | null>;
  create?(ctx: AdapterContext, kind: string, input: Record<string, unknown>): Promise<{ externalId: string; url?: string }>;
  update?(ctx: AdapterContext, externalId: string, patch: Record<string, unknown>): Promise<void>;
  send?(ctx: AdapterContext, req: SendRequest): Promise<{ externalId: string }>;
  subscribe?(ctx: AdapterContext, callbackUrl: string): Promise<{ externalId: string; expiresAt?: Date }>;
  permissions?(ctx: AdapterContext, externalId: string): Promise<string[]>;
}

export class UnsupportedOperation extends Error {
  constructor(provider: string, op: Operation) {
    super(`${provider} does not support ${op}`);
  }
}
