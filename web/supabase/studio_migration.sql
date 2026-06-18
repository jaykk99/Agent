-- web/supabase/studio_migration.sql
--
-- Studio Architecture Migration
-- ─────────────────────────────────────────────────────────────────────────
-- Adds new tables required for:
--   • Procedural state serialisation (agent_execution_states)
--   • Ask Human HITL queue (agent_ask_human_queue)
--   • Workspace skills (workspace_skills)
--   • Compiled GitHub tools (agent_compiled_tools)
--   • OAuth connector registry (agent_oauth_connectors)
--
-- Safe to run on an existing database — uses IF NOT EXISTS throughout.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Procedural Execution State ────────────────────────────────────────────
create table if not exists agent_execution_states (
  "stateId"       text primary key,
  "sessionId"     text not null,
  scope           text not null default 'session',
  "activeRole"    text not null default 'coder',
  goal            text not null default '',
  "pendingTasks"  jsonb not null default '[]',
  "resolvedVars"  jsonb not null default '{}',
  "activeSkills"  jsonb not null default '[]',
  "touchedFiles"  jsonb not null default '[]',
  "errorLog"      jsonb not null default '[]',
  "stepIndex"     integer not null default 0,
  "decayFactor"   real not null default 0.85,
  "createdAt"     timestamptz default now(),
  "updatedAt"     timestamptz default now()
);

create index if not exists idx_exec_states_session
  on agent_execution_states ("sessionId");

create index if not exists idx_exec_states_updated
  on agent_execution_states ("updatedAt" desc);

-- ── Ask Human HITL Queue ──────────────────────────────────────────────────
create table if not exists agent_ask_human_queue (
  "stateId"    text primary key,
  "sessionId"  text not null,
  reason       text not null,
  "errorLog"   jsonb not null default '[]',
  "filePath"   text,
  "resumeStep" integer not null default 0,
  resolved     boolean not null default false,
  "userReply"  text,
  "createdAt"  timestamptz default now()
);

create index if not exists idx_ask_human_session
  on agent_ask_human_queue ("sessionId", resolved);

-- ── Workspace Skills ──────────────────────────────────────────────────────
create table if not exists workspace_skills (
  id              text primary key,
  "sessionId"     text not null,
  name            text not null,
  type            text not null default 'custom',
  instruction     text not null,
  triggers        jsonb not null default '[]',
  "maxInstances"  integer not null default 10,
  enabled         boolean not null default true,
  "createdAt"     timestamptz default now(),
  "updatedAt"     timestamptz default now()
);

create index if not exists idx_skills_session
  on workspace_skills ("sessionId", enabled);

-- ── Compiled GitHub Tools ──────────────────────────────────────────────────
create table if not exists agent_compiled_tools (
  id           text primary key,
  "sessionId"  text not null,
  "repoUrl"    text not null,
  "toolName"   text not null,
  description  text,
  schema       jsonb not null default '{}',
  entrypoint   text,
  language     text,
  dependencies jsonb not null default '[]',
  "compiledAt" timestamptz default now()
);

create index if not exists idx_compiled_tools_session
  on agent_compiled_tools ("sessionId");

-- ── OAuth Connector Registry ──────────────────────────────────────────────
-- Workspace-level OAuth connectors decoupled from execution logic.
-- Credentials are stored encrypted; the token column stores ciphertext only.
create table if not exists agent_oauth_connectors (
  id              text primary key,
  "sessionId"     text not null,
  service         text not null,          -- e.g. 'github', 'google', 'slack'
  display_name    text not null,
  scopes          jsonb not null default '[]',
  -- Encrypted access token (never stored in plaintext client-side)
  access_token_enc  text,
  refresh_token_enc text,
  expires_at        timestamptz,
  redirect_uris     jsonb not null default '[]',
  connected         boolean not null default false,
  "createdAt"       timestamptz default now(),
  "updatedAt"       timestamptz default now(),
  unique ("sessionId", service)
);

create index if not exists idx_oauth_session
  on agent_oauth_connectors ("sessionId", connected);

-- ── Additive columns for agent_messages ──────────────────────────────────
-- Adds tool_calls and model tracking to existing message rows.
alter table if exists agent_messages
  add column if not exists tool_calls       jsonb default '[]',
  add column if not exists model            text  default '',
  add column if not exists agent_role       text  default 'coder',
  add column if not exists state_id         text  default '';

-- ── Row-level Security (optional — enable when multi-user auth is live) ──
-- alter table agent_execution_states enable row level security;
-- alter table agent_ask_human_queue   enable row level security;
-- alter table workspace_skills        enable row level security;
-- alter table agent_compiled_tools    enable row level security;
-- alter table agent_oauth_connectors  enable row level security;

-- ── Updated-at trigger helper ────────────────────────────────────────────
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new."updatedAt" = now();
  return new;
end;
$$ language plpgsql;

create or replace trigger trg_exec_states_updated_at
  before update on agent_execution_states
  for each row execute function update_updated_at_column();

create or replace trigger trg_skills_updated_at
  before update on workspace_skills
  for each row execute function update_updated_at_column();

create or replace trigger trg_oauth_updated_at
  before update on agent_oauth_connectors
  for each row execute function update_updated_at_column();
