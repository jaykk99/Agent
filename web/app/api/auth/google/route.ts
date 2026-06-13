import { NextResponse } from 'next/server';

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'Supabase not configured.' }, { status: 500 });
  }

  const baseUrl   = process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  const redirectTo = `${baseUrl}/?auth=google`;

  // Use Supabase Auth REST API to initiate Google OAuth
  const res = await fetch(`${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`, {
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    redirect: 'manual',
  });

  const location = res.headers.get('location');
  if (!location) {
    return NextResponse.json(
      { error: 'Google OAuth not configured in Supabase. Enable it at: Supabase Dashboard → Auth → Providers → Google.' },
      { status: 503 }
    );
  }
  return NextResponse.redirect(location);
}
