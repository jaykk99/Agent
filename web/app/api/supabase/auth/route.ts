import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET() {
  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'SUPABASE_OAUTH_CLIENT_ID not configured. Add it to your environment variables.' },
      { status: 500 }
    );
  }
  const baseUrl = process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  const redirectUri = `${baseUrl}/api/supabase/callback`;
  const url = `https://api.supabase.com/v1/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=all`;
  return NextResponse.redirect(url);
}
