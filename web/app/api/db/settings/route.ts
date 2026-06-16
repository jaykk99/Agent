/**
 * web/app/api/db/settings/route.ts
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session_id = req.nextUrl.searchParams.get('session_id');
    if (!session_id) return NextResponse.json(null);
    const { data, error } = await getSupabase()
      .from('agent_settings')
      .select('*')
      .eq('session_id', session_id)
      .single();
    if (error && error.code !== 'PGRST116') {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data || null);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = rateLimit(ip, 'db-settings', 60, 60);
  if (!rl.ok) {
    return NextResponse.json({ error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` }, { status: 429 });
  }
  try {
    const body = await req.json();
    if (!body.session_id || typeof body.session_id !== 'string') {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 });
    }
    // Strip any fields that could overwrite system columns
    const { id: _id, created_at: _ca, ...safe } = body;
    const { data, error } = await getSupabase()
      .from('agent_settings')
      .upsert([safe], { onConflict: 'session_id' })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
