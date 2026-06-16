/**
 * web/app/api/mcp/route.ts
 *
 * Standalone MCP proxy endpoint.
 * GET  /api/mcp        — list available servers + tools
 * POST /api/mcp        — proxy a tool call (fetch, memory)
 *
 * NOTE: executeMcpFunction is NO LONGER exported from here.
 * The chat route has its own inlined copy to avoid circular imports.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

const MCP_SERVERS = [
  { name: 'fetch',               type: 'builtin', enabled: true,  description: 'Fetch URLs as clean text' },
  { name: 'memory',              type: 'builtin', enabled: true,  description: 'Key-value memory store' },
  { name: 'sequential-thinking', type: 'npm',     enabled: false, description: 'Structured chain-of-thought reasoning', package: '@modelcontextprotocol/server-sequential-thinking' },
  { name: 'filesystem',          type: 'npm',     enabled: false, description: 'File read/write in /tmp', package: '@modelcontextprotocol/server-filesystem' },
];

// In-memory KV store (per serverless instance — for persistence use the Supabase /api/db/settings route)
const _memStore: Record<string, string> = {};

// ── GET /api/mcp — list servers ──────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({
    servers: MCP_SERVERS,
    tools: [
      { name: 'mcp_fetch_url',  description: 'Fetch a URL as clean text' },
      { name: 'mcp_remember',   description: 'Store a key/value in memory' },
      { name: 'mcp_recall',     description: 'Retrieve a stored memory by key' },
    ],
  });
}

// ── POST /api/mcp — execute a tool ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { tool, arguments: toolArgs = {} } = await req.json();

    if (!tool) {
      return NextResponse.json({ error: 'tool is required' }, { status: 400 });
    }

    // ── fetch tool ────────────────────────────────────────────────────────────
    if (tool === 'mcp_fetch_url' || tool === 'fetch') {
      const url = toolArgs?.url || toolArgs?.uri;
      if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 });
      const maxLen = parseInt(toolArgs?.max_length || '5000');

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MonicoAgent/1.0)' },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}`, url });
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, maxLen);
        return NextResponse.json({ result: text, url, chars: text.length });
      } catch (e) {
        return NextResponse.json({
          error: e instanceof Error ? e.message : 'Fetch failed',
          url,
        }, { status: 502 });
      }
    }

    // ── memory tool ───────────────────────────────────────────────────────────
    if (tool === 'mcp_remember' || tool === 'set') {
      const { key, value } = toolArgs;
      if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
      _memStore[key] = value ?? '';
      return NextResponse.json({ result: `✅ Remembered: ${key}`, key });
    }

    if (tool === 'mcp_recall' || tool === 'get') {
      const { key } = toolArgs;
      if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
      const val = _memStore[key];
      if (val === undefined) return NextResponse.json({ result: `No value stored for: ${key}` });
      return NextResponse.json({ result: val, key });
    }

    if (tool === 'list' || tool === 'mcp_list_keys') {
      const keys = Object.keys(_memStore);
      return NextResponse.json({ result: keys.length ? keys.join(', ') : '(empty)', count: keys.length });
    }

    return NextResponse.json({ error: `Unknown tool: ${tool}. Available: mcp_fetch_url, mcp_remember, mcp_recall` }, { status: 400 });

  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
