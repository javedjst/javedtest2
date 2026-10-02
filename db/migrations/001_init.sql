-- AI Work Hub: core schema. Every tenant-owned table carries org_id and is protected by
-- row level security keyed on the session setting app.org_id (set per transaction by the API).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pgvector is optional. Semantic search degrades to Postgres full text when it is missing.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not available, embeddings column will be skipped';
END $$;

-- ---------------------------------------------------------------- identity & tenancy
CREATE TABLE organisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  settings      jsonb NOT NULL DEFAULT '{}',          -- sso config, retention defaults, ai flags
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','viewer')),
  mfa_enrolled  boolean NOT NULL DEFAULT false,
  preferences   jsonb NOT NULL DEFAULT '{}',          -- writing style, working hours, vip list
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE teams (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name      text NOT NULL,
  UNIQUE (org_id, name)
);
CREATE TABLE team_members (
  org_id    uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  team_id   uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,                   -- sha256 of the opaque session token
  user_agent  text,
  ip          inet,
  mfa_passed  boolean NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- integrations
CREATE TABLE integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL = org-wide connection
  provider      text NOT NULL,                                  -- gmail, gcal, slack, github, jira, confluence...
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','error','revoked','disabled')),
  scopes        text[] NOT NULL DEFAULT '{}',
  external_account text,
  config        jsonb NOT NULL DEFAULT '{}',                    -- site url, workspace id, allowed repos
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, provider)
);

-- Tokens are encrypted by the API (AES-256-GCM, per-record data key wrapped by a KMS/master key).
CREATE TABLE oauth_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  integration_id   uuid NOT NULL UNIQUE REFERENCES integrations(id) ON DELETE CASCADE,
  access_token_enc bytea NOT NULL,
  refresh_token_enc bytea,
  key_id           text NOT NULL,                               -- which master key wrapped the data key
  expires_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_state (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  resource       text NOT NULL,                                 -- 'messages', 'events', 'issues'
  cursor         text,                                          -- historyId, syncToken, updated_since
  last_synced_at timestamptz,
  status         text NOT NULL DEFAULT 'idle',
  UNIQUE (integration_id, resource)
);

CREATE TABLE webhooks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id    text,
  secret_hash    text NOT NULL,                                 -- verify inbound signatures
  expires_at     timestamptz,                                   -- Gmail/Calendar watches expire
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- work data
CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name        text,
  email       text,
  company     text,
  is_vip      boolean NOT NULL DEFAULT false,
  identities  jsonb NOT NULL DEFAULT '{}',                      -- {slack:'U123', github:'rahul'}
  UNIQUE (org_id, email)
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'project' CHECK (kind IN ('project','client','team')),
  external_refs jsonb NOT NULL DEFAULT '{}',                    -- {jira:'SEC', github:'org/repo'}
  restricted  boolean NOT NULL DEFAULT false
);

CREATE TABLE threads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  source        text NOT NULL,
  external_id   text NOT NULL,
  subject       text,
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  UNIQUE (org_id, source, external_id)
);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,    -- whose inbox this lives in
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  thread_id     uuid REFERENCES threads(id) ON DELETE CASCADE,
  source        text NOT NULL,
  kind          text NOT NULL DEFAULT 'message',                -- message, notification, approval, mention, comment
  external_id   text NOT NULL,
  sender_name   text,
  sender_address text,
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  subject       text,
  body          text NOT NULL DEFAULT '',
  sent_at       timestamptz NOT NULL,
  direction     text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  -- AI enrichment
  summary       text,
  priority      text CHECK (priority IN ('urgent','high','normal','low')),
  category      text,                                           -- needs_reply, fyi, approval, meeting, task, waiting
  required_action text,
  deadline      timestamptz,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','snoozed','waiting')),
  -- permission-aware retrieval: principals allowed to read this item ('user:<id>','team:<id>','org:*')
  acl           text[] NOT NULL DEFAULT '{}',
  search_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body,''))) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, external_id)
);
CREATE INDEX messages_inbox_idx ON messages (org_id, owner_user_id, state, sent_at DESC);
CREATE INDEX messages_search_idx ON messages USING gin (search_tsv);
CREATE INDEX messages_acl_idx ON messages USING gin (acl);

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  source        text NOT NULL,
  external_id   text NOT NULL,
  title         text NOT NULL,
  url           text,
  body          text NOT NULL DEFAULT '',
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  acl           text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) STORED,
  UNIQUE (org_id, source, external_id)
);
CREATE INDEX documents_search_idx ON documents USING gin (search_tsv);
CREATE INDEX documents_acl_idx ON documents USING gin (acl);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE TABLE document_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index int NOT NULL,
      content text NOT NULL,
      acl text[] NOT NULL DEFAULT ''{}'',
      embedding vector(1024))';
    EXECUTE 'CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops)';
  END IF;
END $$;

CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title         text NOT NULL,
  description   text,
  owner_hint    text,                                           -- name detected in text before resolution
  due_at        timestamptz,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done','dismissed')),
  priority      text NOT NULL DEFAULT 'normal',
  origin        text NOT NULL DEFAULT 'manual',                 -- manual, ai_extracted, jira, github
  source        text,
  source_ref    text,                                           -- message id, issue key
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  external_key  text,                                           -- JIRA key once converted
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_owner_idx ON tasks (org_id, owner_user_id, status, due_at);

CREATE TABLE meetings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  external_id   text NOT NULL,
  title         text NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  location_url  text,
  provider      text,                                           -- meet, teams, zoom
  agenda        text,
  status        text NOT NULL DEFAULT 'confirmed',
  UNIQUE (org_id, external_id, owner_user_id)
);
CREATE INDEX meetings_time_idx ON meetings (org_id, owner_user_id, starts_at);

CREATE TABLE meeting_participants (
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  email       text NOT NULL,
  response    text NOT NULL DEFAULT 'needsAction',
  PRIMARY KEY (meeting_id, email)
);

CREATE TABLE meeting_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript  text,
  summary     text,
  decisions   jsonb NOT NULL DEFAULT '[]',
  action_items jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  title     text NOT NULL,
  body      text,
  link      text,
  read_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- AI & governance
CREATE TABLE ai_suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,            -- reply, follow_up, task, meeting_conflict, pr_stale, blocker
  subject_ref text,                     -- message / pr / task id
  title       text NOT NULL,
  rationale   text NOT NULL,            -- always explain why
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  action      text NOT NULL,            -- tool name or '*'
  risk        text CHECK (risk IN ('low','medium','high')),
  mode        text NOT NULL CHECK (mode IN ('allow','require_approval','deny')),
  approver_role text NOT NULL DEFAULT 'self' CHECK (approver_role IN ('self','admin')),
  UNIQUE (org_id, action)
);

CREATE TABLE agent_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent       text NOT NULL,
  tool        text NOT NULL,
  risk        text NOT NULL,
  input       jsonb NOT NULL DEFAULT '{}',
  output      jsonb,
  status      text NOT NULL CHECK (status IN ('executed','pending_approval','denied','failed','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id   uuid REFERENCES agent_actions(id) ON DELETE SET NULL,
  tool        text NOT NULL,
  risk        text NOT NULL,
  preview     jsonb NOT NULL,           -- exact payload the user will approve (what you see is what is sent)
  approver_role text NOT NULL DEFAULT 'self',   -- 'self' or 'admin' (from the policy at request time)
  payload_hash text NOT NULL,           -- approval binds to this hash; edits create a new hash
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','executed')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending_idx ON approval_requests (org_id, user_id, status);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  actor_user_id uuid,
  actor_kind  text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','agent','system','admin')),
  event       text NOT NULL,
  target      text,
  detail      jsonb NOT NULL DEFAULT '{}',
  ip          inet,
  prev_hash   text,                     -- hash chain makes tampering detectable
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_time_idx ON audit_logs (org_id, created_at DESC);

CREATE TABLE memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,       -- NULL = org level
  kind        text NOT NULL CHECK (kind IN ('conversation','preference','company','project','relationship','task_history')),
  key         text,
  content     text NOT NULL,
  source_ref  text,
  expires_at  timestamptz,                                       -- retention rule applied at write time
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_lookup_idx ON memories (org_id, user_id, kind);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  principal   text NOT NULL,            -- user:<id>, team:<id>, role:admin
  resource    text NOT NULL,            -- project:<id>, integration:<id>, repo:org/name, tool:send_email
  effect      text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  UNIQUE (org_id, principal, resource)
);

CREATE TABLE automations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  trigger     jsonb NOT NULL,
  steps       jsonb NOT NULL,           -- ordered tool calls, each carries its risk level
  enabled     boolean NOT NULL DEFAULT false,
  auto_send   boolean NOT NULL DEFAULT false,   -- explicit opt-in to run high risk steps without approval
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- tenant isolation (RLS)
-- The API connects as aiwork_app (not owner, not superuser) so policies always apply.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiwork_app') THEN
    CREATE ROLE aiwork_app LOGIN PASSWORD 'aiwork_app_dev';   -- change in every non dev environment
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- organisations has no org_id column; a tenant may only see itself.
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisations
  USING (id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Audit log is append only for the application role.
CREATE OR REPLACE FUNCTION audit_block_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();

GRANT USAGE ON SCHEMA public TO aiwork_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aiwork_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aiwork_app;
REVOKE UPDATE, DELETE ON audit_logs FROM aiwork_app;

-- Login lookups happen before a tenant is known, so sessions and users are resolved through
-- a narrow SECURITY DEFINER function instead of loosening RLS.
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE (session_id uuid, org_id uuid, user_id uuid, role text, email text, display_name text, mfa_passed boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.org_id, s.user_id, u.role, u.email, u.display_name, s.mfa_passed
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION auth_lookup_session(text) TO aiwork_app;

CREATE OR REPLACE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, org_id uuid, role text, display_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, org_id, role, display_name FROM users WHERE lower(email) = lower(p_email) AND disabled_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION auth_find_user(text) TO aiwork_app;
