-- Run this in your Supabase SQL editor to create the required tables

create table if not exists agent_messages (
  id bigserial primary key,
  session_id text not null,
  text text not null,
  is_user boolean not null default false,
  status text default 'SUCCESS',
  api_call_url text,
  api_call_method text,
  api_call_response text,
  api_call_status integer,
  created_at timestamptz default now()
);

create table if not exists agent_api_templates (
  id bigserial primary key,
  session_id text not null,
  name text not null,
  url text not null,
  method text default 'GET',
  headers_json text default '{}',
  params_json text default '{}',
  body_template text,
  description text default '',
  created_at timestamptz default now()
);

create table if not exists agent_service_connections (
  id bigserial primary key,
  session_id text not null,
  service_name text not null,
  api_key text not null,
  created_at timestamptz default now()
);

create table if not exists agent_settings (
  id bigserial primary key,
  session_id text not null unique,
  is_custom_gemini_key_enabled boolean default false,
  custom_gemini_api_key text default '',
  active_model_name text default 'gemini-1.5-flash',
  is_custom_model_enabled boolean default false,
  custom_model_endpoint text default '',
  custom_model_api_key text default '',
  custom_model_name text default '',
  github_token text default '',
  github_username text default '',
  github_avatar_url text default '',
  is_github_connected boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS (optional, for security)
-- alter table agent_messages enable row level security;
-- alter table agent_api_templates enable row level security;
-- alter table agent_service_connections enable row level security;
-- alter table agent_settings enable row level security;
