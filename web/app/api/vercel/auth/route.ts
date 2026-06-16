import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

export async function GET() {
  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'VERCEL_OAUTH_CLIENT_ID not configured in environment.' },
      { status: 500 }
    );
  }
  const baseUrl = process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  const redirectUri = `${baseUrl}/api/vercel/callback`;
  // ✅ Correct Vercel OAuth authorize URL (vercel.com, NOT api.vercel.com/v1)
  const url = `https://vercel.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  return NextResponse.redirect(url);
}
