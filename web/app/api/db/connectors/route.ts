import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const session_id = req.nextUrl.searchParams.get('session_id');
  if (!session_id) return NextResponse.json([]);
  const { data } = await getSupabase().from('agent_api_templates').select('*').eq('session_id', session_id).order('created_at', { ascending: true });
  return NextResponse.json(data || []);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await getSupabase().from('agent_api_templates').insert([body]).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) await getSupabase().from('agent_api_templates').delete().eq('id', id);
  return NextResponse.json({ ok: true });
}
