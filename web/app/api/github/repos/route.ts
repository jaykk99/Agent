import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'No token' }, { status: 400 });
  try {
    const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=30', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const repos = await res.json();
    return NextResponse.json(Array.isArray(repos) ? repos : []);
  } catch {
    return NextResponse.json([]);
  }
}
