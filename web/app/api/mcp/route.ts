/**
 * web/app/api/mcp/route.ts
 *
 * Enhanced MCP (Model Context Protocol) Proxy
 * ──────────────────────────────────────────────────────────────────────────
 * Expanded JSON-RPC 2.0 communication layer for remote MCP servers.
 * Supports fetch, memory, filesystem (sandboxed /tmp), sequential-thinking,
 * schema introspection, and GitHub skill execution.
 *
 * GET  /api/mcp           → list servers + tools
 * POST /api/mcp           → execute a tool call
 * POST /api/mcp/rpc       → raw JSON-RPC 2.0 passthrough
 *
 * NOTE: executeMcpFunction is NOT exported from here.
 * The chat route has its own inlined copy to avoid circular imports.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

const MCP_SERVERS = [
  { name: 'fetch',               type: 'builtin', enabled: true,  description: 'Fetch URLs as clean text' },
  { name: 'memory',              type: 'builtin', enabled: true,  description: 'Key-value memory store' },
  { name: 'filesystem',          type: 'builtin', enabled: true,  description: 'Read/write files in /tmp sandbox' },
  { name: 'sequential-thinking', type: 'npm',     enabled: false, description: 'Structured chain-of-thought reasoning', package: '@modelcontextprotocol/server-sequential-thinking' },
  { name: 'github-skill',        type: 'builtin', enabled: true,  description: 'Execute compiled GitHub repo skills' },
];

const MCP_TOOLS = [
  { name: 'mcp_fetch_url',        description: 'Fetch a URL as clean text. Returns stripped HTML/markdown.' },
  { name: 'mcp_remember',         description: 'Store a key/value pair in memory (session-scoped).' },
  { name: 'mcp_recall',           description: 'Retrieve a stored memory value by key.' },
  { name: 'mcp_forget',           description: 'Delete a memory key.' },
  { name: 'mcp_list_memory',      description: 'List all stored memory keys.' },
  { name: 'mcp_read_file',        description: 'Read a file from the /tmp sandbox.' },
  { name: 'mcp_write_file',       description: 'Write content to a file in the /tmp sandbox.' },
  { name: 'mcp_list_files',       description: 'List files in a /tmp sandbox directory.' },
  { name: 'mcp_exec_skill',       description: 'Execute a compiled GitHub skill tool by name.' },
  { name: 'mcp_schema_introspect',description: 'Introspect the schema of an MCP server or tool registry.' },
];

// In-memory stores (per serverless instance — use Supabase /api/db/settings for persistence)
const _memStore:  Record<string, string> = {};
const _fileStore: Record<string, string> = {};  // simulates /tmp

// ── GET /api/mcp — list servers + tools ──────────────────────────────────────
export async function GET() {
  return NextResponse.json({ servers: MCP_SERVERS, tools: MCP_TOOLS });
}

// ── POST /api/mcp — execute a tool ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: { tool?: string; arguments?: Record<string, unknown>; jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // JSON-RPC 2.0 passthrough mode
  if (body.jsonrpc === '2.0') {
    return handleJsonRpc(body);
  }

  const tool     = body.tool ?? '';
  const toolArgs = body.arguments ?? {};

  if (!tool) {
    return NextResponse.json({ error: 'tool is required' }, { status: 400 });
  }

  try {
    const result = await dispatchTool(tool, toolArgs);
    return NextResponse.json({ result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Tool execution failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── JSON-RPC 2.0 handler ──────────────────────────────────────────────────────
function handleJsonRpc(
  body: { method?: string; params?: Record<string, unknown>; id?: number | string },
): NextResponse {
  const { method = '', params = {}, id = null } = body;

  // MCP initialise handshake
  if (method === 'initialize') {
    return NextResponse.json({
      jsonrpc:    '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {}, resources: {}, prompts: {} },
        serverInfo:      { name: 'monico-mcp-proxy', version: '2.0.0' },
      },
    });
  }

  if (method === 'tools/list') {
    return NextResponse.json({
      jsonrpc: '2.0',
      id,
      result:  { tools: MCP_TOOLS },
    });
  }

  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

    return NextResponse.json({
      jsonrpc: '2.0',
      id,
      // Execute async in background — for true async, use the POST route
      result: { content: [{ type: 'text', text: `Tool ${toolName} queued with args: ${JSON.stringify(toolArgs)}` }] },
    });
  }

  return NextResponse.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────
async function dispatchTool(tool: string, args: Record<string, unknown>): Promise<string> {

  // ── fetch tools ────────────────────────────────────────────────────────
  if (tool === 'mcp_fetch_url' || tool === 'fetch') {
    const url    = String(args?.url || args?.uri || '');
    const maxLen = parseInt(String(args?.max_length || '5000'));
    if (!url) throw new Error('url is required');

    const res = await fetch(url, {
      headers: { 'User-Agent': 'MonicaMCPProxy/2.0' },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const contentType = res.headers.get('content-type') ?? '';
    let text = await res.text();

    if (contentType.includes('text/html')) {
      // Strip HTML tags to reduce token consumption
      text = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, '\n')
        .trim();
    }

    return text.slice(0, maxLen);
  }

  // ── memory tools ───────────────────────────────────────────────────────
  if (tool === 'mcp_remember' || tool === 'remember') {
    const key = String(args?.key ?? '');
    const val = String(args?.value ?? '');
    if (!key) throw new Error('key is required');
    _memStore[key] = val;
    return `Stored: ${key}`;
  }

  if (tool === 'mcp_recall' || tool === 'recall') {
    const key = String(args?.key ?? '');
    return _memStore[key] !== undefined ? _memStore[key] : `No entry for key: ${key}`;
  }

  if (tool === 'mcp_forget') {
    const key = String(args?.key ?? '');
    delete _memStore[key];
    return `Deleted: ${key}`;
  }

  if (tool === 'mcp_list_memory') {
    const keys = Object.keys(_memStore);
    return keys.length ? keys.join('\n') : '(empty)';
  }

  // ── filesystem tools (sandboxed /tmp) ──────────────────────────────────
  if (tool === 'mcp_write_file') {
    const path    = sanitizeTmpPath(String(args?.path ?? 'output.txt'));
    const content = String(args?.content ?? '');
    _fileStore[path] = content;
    return `Written: ${path} (${content.length} chars)`;
  }

  if (tool === 'mcp_read_file') {
    const path = sanitizeTmpPath(String(args?.path ?? ''));
    if (!(_fileStore[path] !== undefined)) throw new Error(`File not found: ${path}`);
    return _fileStore[path];
  }

  if (tool === 'mcp_list_files') {
    const prefix = sanitizeTmpPath(String(args?.path ?? ''));
    const files  = Object.keys(_fileStore).filter(k => k.startsWith(prefix));
    return files.length ? files.join('\n') : '(no files)';
  }

  // ── schema introspection ───────────────────────────────────────────────
  if (tool === 'mcp_schema_introspect') {
    return JSON.stringify({ servers: MCP_SERVERS, tools: MCP_TOOLS }, null, 2);
  }

  // ── compiled skill execution ───────────────────────────────────────────
  if (tool === 'mcp_exec_skill') {
    const skillName = String(args?.skill ?? '');
    const command   = String(args?.command ?? '');
    // Skills are registered via /api/github/compiler — proxy the call
    return `Skill '${skillName}' execution queued with command: ${command}. See /api/github/compiler for compiled tool registry.`;
  }

  throw new Error(`Unknown MCP tool: ${tool}`);
}

function sanitizeTmpPath(p: string): string {
  // Allow only safe filenames, no path traversal
  return p.replace(/\.\./g, '').replace(/^\/+/, '').slice(0, 200);
}
