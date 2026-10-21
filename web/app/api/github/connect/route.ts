import { NextResponse } from 'next/server';
import { appUrl } from '@/lib/appUrl';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

// Redirect to GitHub OAuth flow instead of using a hardcoded server token.
// The actual token exchange happens in /api/github/callback/route.ts
export async function GET() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'GITHUB_CLIENT_ID not configured. Add it to your environment variables.' },
      { status: 500 }
    );
  }
  // OAuth redirect base comes from APP_URL (see lib/appUrl.ts).
  const baseUrl = appUrl();
  const redirectUri = `${baseUrl}/api/github/callback`;
  const scope = 'read:user repo';
  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  return NextResponse.redirect(url);
}
