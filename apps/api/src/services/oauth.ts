import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { randomToken } from '../security/crypto.js';
import type { OAuthConfig } from '../integrations/types.js';

/** OAuth 2.0 authorisation code flow with PKCE. State and verifier live in a signed, httpOnly cookie. */
export function startOAuth(provider: string, oauth: OAuthConfig, clientId: string) {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${config.API_PUBLIC_URL}/integrations/${provider}/callback`;
  const url = new URL(oauth.authUrl);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: oauth.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(oauth.extraParams ?? {}),
  }).toString();
  return { url: url.toString(), state, verifier, redirectUri };
}
