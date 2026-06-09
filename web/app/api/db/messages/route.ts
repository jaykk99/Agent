import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const session_id = req.nextUrl.searchParams.get('session_id');
  if (!session_id) return NextResponse.json([]);
  const { data } = await supabase.from('agent_messages').select('*').eq('session_id', session_id).order('created_at', { ascending: true });
  return NextResponse.json(data || []);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await supabase.from('agent_messages').insert([body]).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  const session_id = req.nextUrl.searchParams.get('session_id');
  const all = req.nextUrl.searchParams.get('all');
  if (all && session_id) {
    await supabase.from('agent_messages').delete().eq('session_id', session_id);
  } else if (id) {
    await supabase.from('agent_messages').delete().eq('id', id);
  }
  return NextResponse.json({ ok: true });
}
