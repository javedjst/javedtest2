# API

Base URL in development: `http://localhost:3000/api` (proxied) or `http://localhost:4000`. JSON in and out. Authentication is a session cookie. State changing requests must send `X-Requested-With: awh`.

Tool backed endpoints return the tool output directly when it ran. If policy requires approval they return **202** `{status:"pending_approval", approvalId, preview}`. Policy denial is **403** `{status:"denied"}`. Tool failure is **422** `{status:"failed", error}`.

| Method and path | Purpose | Tool (risk) |
|---|---|---|
| GET `/health` | liveness, AI mode | |
| POST `/auth/dev-login` `{email}` | development sign-in (needs `DEV_AUTH=true`) | |
| POST `/auth/logout` | revoke session | |
| GET `/me` | current user, role, AI mode | |
| GET `/inbox?filter&source&limit` | unified inbox. filter: all, urgent, needs_reply, waiting, fyi, meeting, task, approval | `list_inbox` (low) |
| GET `/messages/:id` | message with thread | |
| POST `/messages/:id/replies` | reply options | `suggest_replies` (low) |
| POST `/messages/:id/tasks/extract` | detected tasks | `extract_tasks` (low) |
| POST `/messages/:id/resolve` `{state}` | done, snoozed, waiting, open | `resolve_message` (medium) |
| POST `/compose` `{instruction}` | draft from instruction | `compose_draft` (low) |
| POST `/send` `{channel,to[],subject?,body,inReplyTo?}` | send message | `send_message` (**high**) |
| GET `/tasks?status` / POST `/tasks` / PATCH `/tasks/:id` | tasks | `list_tasks` (low), `create_task`, `update_task` (medium) |
| GET `/meetings?from&to` / POST `/meetings` | calendar | `list_meetings` (low), `create_meeting` (medium) |
| POST `/meetings/free-slots` `{durationMin,from,to}` | free slots | `find_free_slots` (low) |
| GET `/meetings/:id/brief` / `/notes` | pre-meeting brief, notes and action items | `meeting_brief`, `meeting_action_items` (low) |
| GET `/briefing` / `/suggestions` | daily briefing, proactive suggestions with reasons | low |
| GET `/github/activity?kind&days` | reviews, CI, security | `github_activity` (low) |
| POST `/search` `{query}` / GET `/timeline?subject` | permission-aware search, timeline | low |
| POST `/ask` `{question}` | cited answer | `ask_company` (low) |
| POST `/command` `{text}` | supervisor: plan and run | per step |
| GET `/agents` | agents, tools, risk levels | |
| GET `/approvals?status` | pending approvals (own, plus admin-approver ones for admins) | |
| POST `/approvals/:id/approve` `{input?}` / `/reject` | decide. `input` replaces the payload and is re-validated | |
| GET `/integrations` | catalog with capabilities and connections | |
| GET `/integrations/:provider/start` / `/callback` | OAuth | |
| POST `/integrations/:id/sync` | run an incremental sync now | |
| DELETE `/integrations/:id` | revoke and delete tokens | |
| GET `/memory`, DELETE `/memory/:id`, DELETE `/memory?kind=` | view and delete memory | `forget_memory` (high) for bulk |
| POST `/automations/preview`, GET/POST `/automations`, POST `/automations/:id/enable` | automations | |
| GET `/admin/audit`, `/admin/audit/verify`, `/admin/actions` | audit and agent actions (admin) | |
| GET/PUT `/admin/policies` | approval policies (admin) | |
| GET `/admin/users`, PATCH `/admin/users/:id` | roles, disable (admin) | |
| GET `/admin/integrations` | all connections (admin) | |

Planned: `POST /webhooks/:provider/:id`, `GET /events` (server-sent events), SSO routes under `/auth/oidc/*`.
