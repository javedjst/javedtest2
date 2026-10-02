export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface Pending { status: 'pending_approval'; approvalId: string; tool: string; risk: string; reason: string; preview: { tool: string; description: string; input: Record<string, unknown> } }
export const isPending = (x: unknown): x is Pending => typeof x === 'object' && x !== null && (x as { status?: string }).status === 'pending_approval';

/** All calls go to /api (proxied by Next to the backend), with the CSRF header the API requires. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'awh' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: { error?: string } | null = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (json === null && text && res.status !== 204) {
    // The proxy answered with plain text, so the API itself did not respond.
    throw new ApiError(res.status || 502, `The API is not reachable (HTTP ${res.status}). Check that API_INTERNAL_URL points to a running API, then redeploy the web app.`);
  }
  if (!res.ok && res.status !== 202) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`, json);
  return json as T;
}
