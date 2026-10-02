# AI Work Hub

One workspace that connects mail, chat, code, tickets, calendar and docs. It ranks what needs you, drafts replies, finds answers across everything you can access, and runs actions for you. **You stay in control:** reading and drafting run freely, anything that sends or changes something outside the app waits for your approval.

It works **for free with no API key**: a built-in local engine handles classification, summaries, task detection, replies and drafting. Add `ANTHROPIC_API_KEY` and replies, drafts and answers are written by Claude, with automatic fallback to the local engine.

## What works today

- Unified inbox with priority, summary, required action, deadline and filters (urgent, needs reply, waiting, FYI, meetings, tasks, approvals)
- Seven reply styles per message, editable, sent only after approval
- Universal composer: "Reply to Rahul and tell him we'll share the report tomorrow"
- Task detection ("Javed, please send the security report by Friday" gives task, owner, deadline)
- Calendar, free slots, conflict detection, pre-meeting briefs, meeting action items
- Permission-aware search, entity timelines, cited answers
- Daily briefing, proactive suggestions that each explain why, follow-up detection
- Command bar that routes to specialised agents
- Risk tiers (low, medium, high), editable approval policies, four-eyes option, hash-chained audit log, admin console
- Integration adapter pattern. **Gmail and GitHub adapters are implemented.** Google Calendar, Slack, Jira, Confluence, Outlook, Teams, WhatsApp and others are declared but not built yet. See [docs/ROADMAP.md](docs/ROADMAP.md)

Tested: 60 tests, including a real Postgres suite for tenant isolation, ACL search, audit integrity and the approval lifecycle. The Gmail and GitHub network code has not been run against live services (needs OAuth apps).

## Quick start

```bash
npm install
cp .env.example .env
createdb aiworkhub                       # Postgres 16
npm run migrate && npm run seed
DEV_AUTH=true npm run dev:api            # :4000
npm run dev:web                          # :3000
```

Open http://localhost:3000 and sign in as `javed@acme.test` (owner), `priya@acme.test` (admin) or `sam@acme.test` (member). Try "Show everything I need to reply to" in the command bar. Docker: `docker compose up --build`.

Tests: `npm test`, or with the database suite `TEST_DB=1 MIGRATION_DATABASE_URL=postgres://postgres@localhost/aiworkhub npm test`.

## Where each design deliverable is

| # | Deliverable | Location |
|---|---|---|
| 1, 2 | Product and system architecture, diagram | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) sections 1, 2 |
| 3, 14 | Agents and orchestration | ARCHITECTURE section 3, `apps/api/src/agents/` |
| 4, 12 | Integration architecture, OAuth flow | ARCHITECTURE sections 4, 9, `apps/api/src/integrations/` |
| 5 | Security architecture | [docs/SECURITY.md](docs/SECURITY.md) |
| 6, 21 | Database schema and migrations | `db/migrations/001_init.sql`, ARCHITECTURE section 5 |
| 7 | API structure | [docs/API.md](docs/API.md) |
| 8 | Repository structure | ARCHITECTURE section 6 |
| 9, 10 | UI architecture and wireframe | ARCHITECTURE section 7, `apps/web/` |
| 11 | Authentication design | ARCHITECTURE section 8 |
| 13 | Permission model | ARCHITECTURE section 10 |
| 15 | Memory | ARCHITECTURE section 11 |
| 16 | Approval workflow | ARCHITECTURE section 13 |
| 17 | MVP roadmap | [docs/ROADMAP.md](docs/ROADMAP.md) |
| 18, 19, 20 | Local setup, env vars, Docker | ARCHITECTURE sections 16, 17, `.env.example`, `docker-compose.yml` |
| 22, 23 | Backend and frontend | `apps/api/`, `apps/web/` |
| 24 | First integration | `apps/api/src/integrations/gmail.ts` (and `github.ts`) |
| 25 | Testing strategy | ARCHITECTURE section 15, `apps/api/tests/` |
| 26 | Deployment architecture | ARCHITECTURE section 18 |

## Adding an integration

Create `apps/api/src/integrations/<name>.ts` exporting an `IntegrationAdapter` (declare `supports`, implement those methods), register it in `registry.ts`, and add its OAuth env vars. The inbox, search, agents, admin and UI pick it up with no other change.
