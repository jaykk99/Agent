import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const session_id = req.nextUrl.searchParams.get('session_id');
  if (!session_id) return NextResponse.json(null);
  const { data } = await getSupabase().from('agent_settings').select('*').eq('session_id', session_id).single();
  return NextResponse.json(data || null);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await getSupabase().from('agent_settings')
    .upsert([{ ...body }], { onConflict: 'session_id' }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
