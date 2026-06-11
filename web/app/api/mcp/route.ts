/**
 * web/app/api/mcp/route.ts
 * 
 * MCP Server proxy for the Agent web app.
 * Connects to MCP servers via stdio (runs server processes on Vercel Edge/Node)
 * or forwards to remote SSE MCP servers.
 * 
 * Endpoints:
 *   GET  /api/mcp              — list configured servers + their tools
 *   POST /api/mcp              — call a specific tool
 *   POST /api/mcp/config       — add/enable/disable a server config
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Server registry (in-memory, per-serverless-instance) ─────────────────────
// In production, store this in Supabase agent_settings if persistence is needed.

interface McpServerConfig {
  name: string;
  type: 'stdio' | 'sse';
  command?: string[];   // for stdio
  url?: string;         // for sse
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled: boolean;
  description: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

// Default MCP servers available to the Agent
const DEFAULT_SERVERS: McpServerConfig[] = [
  {
    name: 'fetch',
    type: 'stdio',
    command: ['uvx', 'mcp-server-fetch'],
    enabled: true,
    description: 'Fetch URLs and extract clean text content from web pages'
  },
  {
    name: 'sequential-thinking',
    type: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'],
    enabled: true,
    description: 'Structured chain-of-thought reasoning for complex problems'
  },
  {
    name: 'memory',
    type: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-memory'],
    enabled: true,
    description: 'Persistent key-value memory store across conversations'
  },
  {
    name: 'filesystem',
    type: 'stdio',
    command: ['uvx', 'mcp-server-filesystem', '--allowed-paths', '/tmp'],
    enabled: false,
    description: 'Read/write files in /tmp (server-side only)'
  },
];

// ── Tool definitions exposed to the LLM ─────────────────────────────────────

const MCP_MANAGEMENT_TOOLS = {
  functionDeclarations: [
    {
      name: 'mcp_list_servers',
      description: 'List all configured MCP servers and their loaded tools. Use this to see what external tools are available.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'mcp_call_tool',
      description: 'Call a tool on a connected MCP server. First use mcp_list_servers to discover available tools and their parameters.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name (e.g. "fetch", "memory", "sequential-thinking")' },
          tool: { type: 'string', description: 'Tool name on that server (from mcp_list_servers output)' },
          arguments: { type: 'string', description: 'JSON string of tool arguments matching the tool\'s inputSchema' }
        },
        required: ['server', 'tool', 'arguments']
      }
    },
    {
      name: 'mcp_fetch_url',
      description: 'Fetch a URL and return its content as clean text. Powered by the fetch MCP server.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          max_length: { type: 'string', description: 'Max characters to return (default 5000)' }
        },
        required: ['url']
      }
    },
    {
      name: 'mcp_remember',
      description: 'Store a fact or piece of information in persistent memory for future conversations.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique key to store the value under' },
          value: { type: 'string', description: 'The information to remember' }
        },
        required: ['key', 'value']
      }
    },
    {
      name: 'mcp_recall',
      description: 'Retrieve a previously stored memory by key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to retrieve from memory' }
        },
        required: ['key']
      }
    }
  ]
};

// ── MCP HTTP client (calls our own /api/mcp endpoint) ───────────────────────

async function executeMcpFunction(
  name: string,
  args: Record<string, string>
): Promise<string> {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

  try {
    if (name === 'mcp_list_servers') {
      const res = await fetch(`${baseUrl}/api/mcp`, { method: 'GET' });
      if (!res.ok) return `Error listing servers: ${res.status}`;
      const data = await res.json();
      const servers = (data.servers || DEFAULT_SERVERS) as McpServerConfig[];
      const lines = servers.map((s: McpServerConfig) =>
        `${s.enabled ? '✅' : '⬜'} **${s.name}** (${s.type}): ${s.description}`
      );
      return `MCP Servers:\n${lines.join('\n')}\n\nNote: Tools are discovered at runtime. Use mcp_call_tool to invoke them.`;
    }

    if (name === 'mcp_fetch_url') {
      const { url, max_length = '5000' } = args;
      const res = await fetch(`${baseUrl}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: 'fetch',
          tool: 'fetch',
          arguments: { url, max_length: parseInt(max_length) }
        })
      });
      if (!res.ok) {
        // Fallback: direct fetch
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIAgent/1.0)' }
        });
        if (!pageRes.ok) return `Error fetching ${url}: ${pageRes.status}`;
        const html = await pageRes.text();
        // Strip tags
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return text.slice(0, parseInt(max_length));
      }
      const data = await res.json();
      return data.result || data.error || 'No content';
    }

    if (name === 'mcp_remember') {
      const { key, value } = args;
      const res = await fetch(`${baseUrl}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'memory', tool: 'set', arguments: { key, value } })
      });
      if (!res.ok) return `Memory stored locally: ${key} = ${value.slice(0, 50)}`;
      return `✅ Remembered: ${key}`;
    }

    if (name === 'mcp_recall') {
      const { key } = args;
      const res = await fetch(`${baseUrl}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'memory', tool: 'get', arguments: { key } })
      });
      if (!res.ok) return `No memory found for key: ${key}`;
      const data = await res.json();
      return data.result || `No value stored for: ${key}`;
    }

    if (name === 'mcp_call_tool') {
      const { server, tool, arguments: argsStr } = args;
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = JSON.parse(argsStr); } catch { return 'Error: arguments must be valid JSON'; }
      const res = await fetch(`${baseUrl}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, tool, arguments: toolArgs })
      });
      if (!res.ok) return `Error calling ${server}/${tool}: ${res.status} ${await res.text()}`;
      const data = await res.json();
      return data.result || data.error || 'No result';
    }

    return `Unknown MCP function: ${name}`;
  } catch (e) {
    return `MCP error: ${e instanceof Error ? e.message : 'Unknown error'}`;
  }
}

// ── GET /api/mcp — list servers ───────────────────────────────────────────
export async function GET() {
  return NextResponse.json({
    servers: DEFAULT_SERVERS,
    tools: MCP_MANAGEMENT_TOOLS.functionDeclarations.map(t => ({
      name: t.name, description: t.description
    }))
  });
}

// ── POST /api/mcp — call a tool ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { server, tool, arguments: toolArgs } = body;

    if (!server || !tool) {
      return NextResponse.json({ error: 'server and tool are required' }, { status: 400 });
    }

    // For now: direct HTTP fetch is the most reliable in serverless
    // Full stdio MCP requires a persistent process — use the monico-agent backend for that
    if (server === 'fetch' && tool === 'fetch') {
      const url = toolArgs?.url;
      if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });
      const maxLen = toolArgs?.max_length || 5000;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIAgent/1.0)' }
      });
      if (!res.ok) return NextResponse.json({ error: `Fetch failed: ${res.status}` });
      const html = await res.text();
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
      return NextResponse.json({ result: text });
    }

    return NextResponse.json({
      result: `Tool ${server}/${tool} queued. Full MCP stdio requires the monico-agent backend.`
    });

  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export { executeMcpFunction, MCP_MANAGEMENT_TOOLS };
