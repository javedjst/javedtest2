import type { IntegrationAdapter, Operation } from './types.js';

/**
 * Manifest-only adapters. They are registered so the Integrations screen, the admin console and the
 * agents can show what is coming and what each will support, but they have no network code yet.
 * Replace an entry with a full adapter file (see gmail.ts) to promote it to status 'ready'.
 */
const planned = (provider: string, displayName: string, category: IntegrationAdapter['category'], supports: Operation[]): IntegrationAdapter => ({
  provider, displayName, category, supports, status: 'planned',
});

const all: Operation[] = ['connect', 'disconnect', 'sync', 'search', 'read', 'create', 'update', 'send', 'subscribe', 'permissions'];

export const plannedAdapters: IntegrationAdapter[] = [
  planned('gcal', 'Google Calendar', 'calendar', ['connect', 'disconnect', 'sync', 'search', 'read', 'create', 'update', 'subscribe']),
  planned('slack', 'Slack', 'chat', ['connect', 'disconnect', 'sync', 'search', 'read', 'send', 'subscribe', 'permissions']),
  planned('jira', 'Jira', 'tickets', ['connect', 'disconnect', 'sync', 'search', 'read', 'create', 'update', 'subscribe', 'permissions']),
  planned('confluence', 'Confluence', 'knowledge', ['connect', 'disconnect', 'sync', 'search', 'read', 'create', 'update', 'permissions']),
  planned('gdrive', 'Google Drive', 'knowledge', ['connect', 'disconnect', 'sync', 'search', 'read', 'permissions']),
  planned('outlook', 'Outlook / Microsoft 365', 'email', ['connect', 'disconnect', 'sync', 'search', 'read', 'send', 'subscribe']),
  planned('teams', 'Microsoft Teams', 'chat', ['connect', 'disconnect', 'sync', 'search', 'read', 'send', 'subscribe']),
  planned('whatsapp', 'WhatsApp Business', 'chat', ['connect', 'disconnect', 'sync', 'read', 'send', 'subscribe']),
  planned('gitlab', 'GitLab', 'code', all.filter((o) => o !== 'send')),
  planned('notion', 'Notion', 'knowledge', ['connect', 'disconnect', 'sync', 'search', 'read', 'create', 'update']),
];
