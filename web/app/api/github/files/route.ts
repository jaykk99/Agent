import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token') || process.env.GITHUB_TOKEN;
  const repo = searchParams.get('repo'); // e.g. "owner/name"
  const path = searchParams.get('path') || '';

  if (!token || !repo) {
    return NextResponse.json({ error: 'token and repo required' }, { status: 400 });
  }

  try {
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'AIAgent' }
    });
    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json({ error: err.message }, { status: res.status });
    }
    const data = await res.json();

    // If it's a file, decode its content
    if (!Array.isArray(data) && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return NextResponse.json({ type: 'file', name: data.name, path: data.path, content, size: data.size });
    }

    // It's a directory listing
    const items = Array.isArray(data) ? data.map((item: { name: string; path: string; type: string; size: number }) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size
    })) : [];

    return NextResponse.json({ type: 'dir', path, items });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
