import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const code    = req.nextUrl.searchParams.get('code');
  const baseUrl = process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  if (!code) return NextResponse.redirect(`${baseUrl}/?error=vr_no_code`);

  const clientId     = process.env.VERCEL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.VERCEL_OAUTH_CLIENT_SECRET;
  const redirectUri  = `${baseUrl}/api/vercel/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${baseUrl}/?error=vr_not_configured`);
  }

  try {
    // ✅ Correct token endpoint: v2
    const tokenRes = await fetch('https://api.vercel.com/v2/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    if (!token) {
      console.error('Vercel OAuth error:', JSON.stringify(tokenData));
      return NextResponse.redirect(`${baseUrl}/?error=vr_no_token&detail=${encodeURIComponent(tokenData.error || 'unknown')}`);
    }

    const userRes  = await fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const userData = await userRes.json();
    const username = userData?.user?.username || userData?.user?.name || '';

    const redir = new URL(baseUrl);
    redir.searchParams.set('vr_token', token);
    redir.searchParams.set('vr_user',  username);
    return NextResponse.redirect(redir.toString());
  } catch (err) {
    console.error('Vercel OAuth callback failed:', err);
    return NextResponse.redirect(`${baseUrl}/?error=vr_oauth_failed`);
  }
}
