import { listAdapters } from '../integrations/registry.js';
import { tools } from './tools.js';

export interface AgentInfo { name: string; description: string; tools: string[]; status: 'ready' | 'planned' }

const DESCRIPTIONS: Record<string, [string, 'ready' | 'planned']> = {
  supervisor: ['Routes each request to the right agents, runs steps through the executor, merges results', 'ready'],
  communication: ['Unified inbox, reply suggestions, universal composer, sending (high risk, approval gated)', 'ready'],
  email: ['Gmail specifics: threads, labels, sync (adapter backed). Shares tools with communication', 'ready'],
  calendar: ['Free slot search, conflict detection, event creation', 'ready'],
  meeting: ['Pre-meeting briefs; post-meeting summaries and action items (needs transcript source)', 'ready'],
  slack: ['Slack messages, channels, mentions (adapter planned)', 'planned'],
  whatsapp: ['WhatsApp Business conversations (adapter planned)', 'planned'],
  github: ['Pull requests, reviews, CI and security notifications', 'ready'],
  jira: ['Issues, sprints, blockers (adapter planned)', 'planned'],
  knowledge: ['Permission-aware answers with cited sources', 'ready'],
  task: ['Detect, create, update and convert tasks', 'ready'],
  search: ['Universal search and entity timelines', 'ready'],
  security: ['Prompt injection scanning, RBAC, approval policy. Enforced in the executor, not optional', 'ready'],
  workflow: ['Daily briefing, proactive suggestions, automation preview', 'ready'],
};

export function listAgents(): AgentInfo[] {
  return Object.entries(DESCRIPTIONS).map(([name, [description, status]]) => ({ name, description, status, tools: tools.filter((t) => t.agent === name).map((t) => t.name) }));
}

export const integrationCatalog = () => listAdapters().map((a) => ({ provider: a.provider, name: a.displayName, category: a.category, status: a.status, supports: a.supports }));
