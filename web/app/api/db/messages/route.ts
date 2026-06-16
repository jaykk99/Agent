/**
 * web/app/api/db/messages/route.ts
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session_id = req.nextUrl.searchParams.get('session_id');
    if (!session_id) return NextResponse.json([]);
    const { data, error } = await getSupabase()
      .from('agent_messages')
      .select('*')
      .eq('session_id', session_id)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data || []);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = rateLimit(ip, 'db-messages', 120, 60);
  if (!rl.ok) {
    return NextResponse.json({ error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` }, { status: 429 });
  }
  try {
    const body = await req.json();
    if (!body.session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
    if (typeof body.text !== 'string') return NextResponse.json({ error: 'text required' }, { status: 400 });
    // Truncate giant messages before storing
    const safeBody = { ...body, text: (body.text || '').slice(0, 50_000) };
    const { id: _id, created_at: _ca, ...insert } = safeBody;
    const { data, error } = await getSupabase()
      .from('agent_messages')
      .insert([insert])
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    const session_id = req.nextUrl.searchParams.get('session_id');
    const all = req.nextUrl.searchParams.get('all');
    const sb = getSupabase();
    if (all && session_id) {
      await sb.from('agent_messages').delete().eq('session_id', session_id);
    } else if (id) {
      await sb.from('agent_messages').delete().eq('id', id);
    } else {
      return NextResponse.json({ error: 'id or session_id+all required' }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
