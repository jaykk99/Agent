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
  -- Gemini / model config
  is_custom_gemini_key_enabled boolean default false,
  custom_gemini_api_key text default '',
  active_model_name text default 'gemini-2.5-flash',
  is_custom_model_enabled boolean default false,
  custom_model_endpoint text default '',
  custom_model_api_key text default '',
  custom_model_name text default '',
  -- GitHub
  github_token text default '',
  github_username text default '',
  github_avatar_url text default '',
  is_github_connected boolean default false,
  -- Google (Supabase auth sign-in)
  is_google_connected boolean default false,
  google_user_email text default '',
  google_user_name text default '',
  google_avatar_url text default '',
  -- Supabase management integration
  is_supabase_connected boolean default false,
  supabase_access_token text default '',
  supabase_url text default '',
  supabase_username text default '',
  -- Vercel integration
  is_vercel_connected boolean default false,
  vercel_access_token text default '',
  vercel_username text default '',
  -- HuggingFace
  hf_api_key text default '',
  -- Web search
  enable_web_search boolean default false,
  -- Timestamps
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Migration: add missing columns to existing databases ─────────────────────
-- Safe to run even if columns already exist (uses IF NOT EXISTS)
alter table if exists agent_settings add column if not exists is_google_connected boolean default false;
alter table if exists agent_settings add column if not exists google_user_email text default '';
alter table if exists agent_settings add column if not exists google_user_name text default '';
alter table if exists agent_settings add column if not exists google_avatar_url text default '';
alter table if exists agent_settings add column if not exists is_supabase_connected boolean default false;
alter table if exists agent_settings add column if not exists supabase_access_token text default '';
alter table if exists agent_settings add column if not exists supabase_url text default '';
alter table if exists agent_settings add column if not exists supabase_username text default '';
alter table if exists agent_settings add column if not exists is_vercel_connected boolean default false;
alter table if exists agent_settings add column if not exists vercel_access_token text default '';
alter table if exists agent_settings add column if not exists vercel_username text default '';
alter table if exists agent_settings add column if not exists hf_api_key text default '';
alter table if exists agent_settings add column if not exists enable_web_search boolean default false;

-- Enable RLS (optional, for security)
-- alter table agent_messages enable row level security;
-- alter table agent_api_templates enable row level security;
-- alter table agent_service_connections enable row level security;
-- alter table agent_settings enable row level security;
