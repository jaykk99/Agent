import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/?error=no_code`);

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/?error=no_token`);

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const user = await userRes.json();

    const redirectUrl = new URL(process.env.NEXTAUTH_URL!);
    redirectUrl.searchParams.set('gh_token', token);
    redirectUrl.searchParams.set('gh_user', user.login);
    redirectUrl.searchParams.set('gh_avatar', user.avatar_url || '');
    return NextResponse.redirect(redirectUrl.toString());
  } catch {
    return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/?error=oauth_failed`);
  }
}
