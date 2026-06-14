/**
 * web/app/api/github/repos/route.ts
 */
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = rateLimit(ip, 'github-repos', 10, 60);
  if (!rl.ok) {
    return NextResponse.json({ error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` }, { status: 429 });
  }
  try {
    // Accept token from query param (sent by frontend) or env fallback
    const token = req.nextUrl.searchParams.get('token') || process.env.GITHUB_TOKEN;
    if (!token) return NextResponse.json({ error: 'No GitHub token. Connect GitHub first.' }, { status: 401 });
    const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AIAgent/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      return NextResponse.json({ error: err.message || res.statusText }, { status: res.status });
    }
    const repos = await res.json();
    return NextResponse.json(Array.isArray(repos) ? repos : []);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
