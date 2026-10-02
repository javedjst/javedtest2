/** fetch with timeout, bounded retries on 429/5xx (honouring Retry-After) and jittered backoff. */
export async function request(url: string, init: RequestInit & { retries?: number; timeoutMs?: number } = {}): Promise<Response> {
  const { retries = 3, timeoutMs = 15_000, ...rest } = init;
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoff(attempt++));
    } finally {
      clearTimeout(timer);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const backoff = (attempt: number) => Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2);

export async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}
