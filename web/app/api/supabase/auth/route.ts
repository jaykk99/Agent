import { NextResponse } from 'next/server';

export async function GET() {
  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const baseUrl = process.env.NEXTAUTH_URL || `https://${process.env.VERCEL_URL}`;
  const redirectUri = `${baseUrl}/api/supabase/callback`;
  const url = `https://api.supabase.com/v1/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=all`;
  return NextResponse.redirect(url);
}
