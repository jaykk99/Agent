import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

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

    // Fetch profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const user = await userRes.json();

    // Fetch primary email (scope: user:email)
    let email = user.email || '';
    if (!email) {
      try {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
        const emails: Array<{ email: string; primary: boolean }> = await emailRes.json();
        email = emails.find(e => e.primary)?.email || emails[0]?.email || '';
      } catch { /* ignore */ }
    }

    // Fetch user's repos so the agent has full context on sign-in
    let reposContext: unknown[] = [];
    try {
      const reposRes = await fetch('https://api.github.com/user/repos?per_page=50&sort=updated&affiliation=owner,collaborator', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (reposRes.ok) {
        const repos: Array<{ name: string; full_name: string; description: string | null; language: string | null; private: boolean; default_branch: string; updated_at: string; stargazers_count: number }> = await reposRes.json();
        reposContext = repos.map(r => ({
          name: r.name,
          full_name: r.full_name,
          description: r.description,
          language: r.language,
          private: r.private,
          default_branch: r.default_branch,
          updated_at: r.updated_at,
          stars: r.stargazers_count,
        }));
      }
    } catch { /* non-fatal */ }

    const ghContext = JSON.stringify({ repos: reposContext, username: user.login, avatar: user.avatar_url, bio: user.bio || '', public_repos: user.public_repos });

    const redirectUrl = new URL(baseUrl);
    redirectUrl.searchParams.set('gh_token',   token);
    redirectUrl.searchParams.set('gh_user',    user.login || '');
    redirectUrl.searchParams.set('gh_avatar',  user.avatar_url || '');
    redirectUrl.searchParams.set('gh_email',   email);
    redirectUrl.searchParams.set('gh_context', Buffer.from(ghContext).toString('base64'));
    return NextResponse.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('GitHub OAuth callback failed:', err);
    return NextResponse.redirect(`${baseUrl}/?error=oauth_failed`);
  }
}
