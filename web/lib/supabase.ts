/**
 * web/lib/supabase.ts
 * Singleton Supabase client — uses service role key server-side for full DB access.
 * Falls back gracefully if env vars are missing (dev without Supabase).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY          ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  if (!url || !key) {
    // Return a no-op client that won't crash — queries will just fail gracefully
    console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_ANON_KEY — DB operations disabled');
    _client = createClient('https://placeholder.supabase.co', 'placeholder');
    return _client;
  }

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
  return _client;
}

/** Browser-side anon client (for auth flows in page.tsx) */
export function getSupabaseBrowser(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Supabase not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createClient(url, key);
}
