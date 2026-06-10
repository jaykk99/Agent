import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');

  const baseUrl = process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  if (!code) return NextResponse.redirect(`${baseUrl}/?error=no_code`);

  const clientId     = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${baseUrl}/?error=oauth_not_configured`);
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    if (!token) {
      console.error('GitHub OAuth error:', tokenData);
      return NextResponse.redirect(`${baseUrl}/?error=no_token`);
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const user = await userRes.json();

    const redirectUrl = new URL(baseUrl);
    redirectUrl.searchParams.set('gh_token', token);
    redirectUrl.searchParams.set('gh_user', user.login || '');
    redirectUrl.searchParams.set('gh_avatar', user.avatar_url || '');
    return NextResponse.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('GitHub OAuth callback failed:', err);
    return NextResponse.redirect(`${baseUrl}/?error=oauth_failed`);
  }
}
