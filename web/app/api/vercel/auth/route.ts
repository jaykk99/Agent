import { NextResponse } from 'next/server';
import { appUrl } from '@/lib/appUrl';

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
  const baseUrl = appUrl();
  const redirectUri = `${baseUrl}/api/vercel/callback`;
  // ✅ Correct Vercel OAuth authorize URL (vercel.com, NOT api.vercel.com/v1)
  const url = `https://vercel.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  return NextResponse.redirect(url);
}
