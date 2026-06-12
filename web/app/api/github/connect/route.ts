import { NextResponse } from 'next/server';

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
  // IMPORTANT: Use parentheses to ensure correct operator precedence.
  // Without them: `A || B ? C : D` evaluates as `(A || B) ? C : D` — wrong.
  const baseUrl = process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  const redirectUri = `${baseUrl}/api/github/callback`;
  const scope = 'read:user repo';
  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  return NextResponse.redirect(url);
}
