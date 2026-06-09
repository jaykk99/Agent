import { NextResponse } from 'next/server';

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return NextResponse.json({ error: 'GITHUB_TOKEN not set' }, { status: 500 });
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    const user = await res.json();
    return NextResponse.json({ token, username: user.login, avatar_url: user.avatar_url });
  } catch {
    return NextResponse.json({ error: 'Failed to connect' }, { status: 500 });
  }
}
