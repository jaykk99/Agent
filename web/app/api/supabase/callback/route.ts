import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const baseUrl = process.env.NEXTAUTH_URL || `https://${process.env.VERCEL_URL}` || 'http://localhost:3000';

  if (!code) return NextResponse.redirect(`${baseUrl}/?error=sb_no_code`);

  const clientId     = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET;
  const redirectUri  = `${baseUrl}/api/supabase/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${baseUrl}/?error=sb_not_configured`);
  }

  try {
    const tokenRes = await fetch('https://api.supabase.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    if (!token) {
      console.error('Supabase OAuth error:', tokenData);
      return NextResponse.redirect(`${baseUrl}/?error=sb_no_token`);
    }

    // Fetch the user's Supabase profile
    const userRes = await fetch('https://api.supabase.com/v1/profile', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const user = await userRes.json();

    const redirectUrl = new URL(baseUrl);
    redirectUrl.searchParams.set('sb_token', token);
    redirectUrl.searchParams.set('sb_user', user.username || user.primary_email || '');
    return NextResponse.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('Supabase OAuth callback failed:', err);
    return NextResponse.redirect(`${baseUrl}/?error=sb_oauth_failed`);
  }
}
