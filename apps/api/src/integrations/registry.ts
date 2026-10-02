import { githubAdapter } from './github.js';
import { gmailAdapter } from './gmail.js';
import { plannedAdapters } from './planned.js';
import { UnsupportedOperation, type IntegrationAdapter, type Operation } from './types.js';

const adapters = new Map<string, IntegrationAdapter>();
for (const a of [gmailAdapter, githubAdapter, ...plannedAdapters]) adapters.set(a.provider, a);

export const registerAdapter = (a: IntegrationAdapter) => adapters.set(a.provider, a);
export const listAdapters = () => [...adapters.values()];
export const getAdapter = (provider: string) => adapters.get(provider);

/** Single choke point: refuses undeclared operations and adapters that are not implemented yet. */
export function requireOperation(provider: string, op: Operation): IntegrationAdapter {
  const a = adapters.get(provider);
  if (!a) throw new Error(`Unknown integration ${provider}`);
  if (!a.supports.includes(op) || !a[op as keyof IntegrationAdapter]) throw new UnsupportedOperation(provider, op);
  return a;
}
