# MVP roadmap

## Phase 1: MVP (this repository)

Target integrations: Gmail, Google Calendar, Slack, GitHub, Jira, Confluence.

| Item | State |
|---|---|
| Unified inbox, AI summaries, priority, suggested replies | done |
| Universal search, timelines, cited answers | done |
| Task extraction | done |
| Calendar view, free slots, conflicts, meeting briefs | done (events stored locally) |
| GitHub summary | done (adapter reads notifications) |
| AI command bar, approval system, audit logs, admin console | done |
| Free local AI engine with Claude upgrade | done |
| Gmail adapter | done, needs live credentials to exercise |
| GitHub adapter | done, needs live credentials to exercise |
| Google Calendar, Slack, Jira, Confluence adapters | **not built**: manifests only, UI and tools already expect them |

Honest note on verification: the API, database, approval flow, ACL search, and UI were exercised end to end against seeded data. Gmail and GitHub network code has not been run against the real services because that needs OAuth apps and accounts.

### Next, in order

1. **Google Calendar adapter** (events sync, create with Meet link, invites). Unlocks real scheduling.
2. **Slack adapter** (OAuth install, mentions and DMs sync, send as user).
3. **Jira adapter** (assigned issues, create and transition, sprint blockers). Unlocks task conversion.
4. **Confluence adapter** (page sync with space and page restrictions mapped to ACL).
5. **Queue and webhooks** (BullMQ worker, signature verified webhook routes, watch renewal).
6. **OIDC SSO, TOTP**, session device list.
7. **KMS key wrapper** and Secrets Manager config loading.

## Phase 2

- Automation runner (event match, step execution via executor with `origin: automation`)
- Embeddings and hybrid search (pgvector), chunking, re-index on change
- Meeting transcripts and summaries (Meet or Teams transcript APIs, with consent controls), follow-up drafts
- Automatic memory writes with retention job and per-kind admin limits
- Server-sent events for live inbox and approval updates
- Model-backed planner in the Supervisor (still bound by the executor)

## Phase 3

WhatsApp Business, Microsoft Outlook, Calendar and Teams, Zoom, GitLab, Drive and OneDrive, Notion, CRM connectors, internal dashboards through a generic REST or MCP adapter. Per-tenant regional data residency. SOC 2 evidence collection from the audit log.
