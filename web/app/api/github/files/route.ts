import { NextRequest, NextResponse } from 'next/server';

const getToken = () => process.env.GITHUB_TOKEN;

// GET: read file or list directory
export async function GET(req: NextRequest) {
  const token = getToken();
  if (!token) return NextResponse.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });

  const repo = req.nextUrl.searchParams.get('repo');
  const path = req.nextUrl.searchParams.get('path') || '';
  if (!repo) return NextResponse.json({ error: 'repo param required' }, { status: 400 });

  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'AIAgent' }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return NextResponse.json({ error: err.message || res.statusText }, { status: res.status });
  }

  const data = await res.json();

  if (!Array.isArray(data) && data.content) {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return NextResponse.json({ type: 'file', name: data.name, path: data.path, content, sha: data.sha, size: data.size });
  }

  const items = Array.isArray(data)
    ? data.map((f: { name: string; path: string; type: string; size: number; sha: string }) => ({
        name: f.name, path: f.path, type: f.type, size: f.size, sha: f.sha
      }))
    : [];

  return NextResponse.json({ type: 'dir', path, items });
}

// PUT: create or update a file
export async function PUT(req: NextRequest) {
  const token = getToken();
  if (!token) return NextResponse.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });

  const { repo, path, content, message, sha, branch } = await req.json();
  if (!repo || !path || content === undefined || !message) {
    return NextResponse.json({ error: 'repo, path, content, message are required' }, { status: 400 });
  }

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64')
  };
  if (sha) body.sha = sha; // required for updates, omit for new files
  if (branch) body.branch = branch;

  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AIAgent'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json({ error: data.message || res.statusText }, { status: res.status });
  }
  return NextResponse.json({ success: true, sha: data.content?.sha, url: data.content?.html_url });
}

// DELETE: delete a file
export async function DELETE(req: NextRequest) {
  const token = getToken();
  if (!token) return NextResponse.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });

  const { repo, path, sha, message, branch } = await req.json();
  if (!repo || !path || !sha || !message) {
    return NextResponse.json({ error: 'repo, path, sha, message are required' }, { status: 400 });
  }

  const body: Record<string, string> = { message, sha };
  if (branch) body.branch = branch;

  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AIAgent'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json({ error: data.message || res.statusText }, { status: res.status });
  }
  return NextResponse.json({ success: true });
}
