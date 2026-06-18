/**
 * web/app/api/github/compiler/route.ts
 *
 * Dynamic GitHub Skill Compiler
 * ──────────────────────────────────────────────────────────────────────────
 * Accepts a GitHub repository URL and compiles it into an OpenAPI-compliant
 * tool schema that any agent in the workspace can execute.
 *
 * Three-phase ingestion pipeline:
 *   1. Clone — fetch repo tree, extract structural definitions + deps
 *   2. Parse  — AST-proxy: extract README instructions, CLI endpoints, exports
 *   3. Compile — package into a secure runtime tool schema (OpenAPI 3.0 subset)
 *
 * POST /api/github/compiler
 *   Body: { repoUrl: string, sessionId: string, toolName?: string }
 *   Returns: CompiledTool
 *
 * GET /api/github/compiler?sessionId=...
 *   Returns: CompiledTool[]  (all compiled tools for this session)
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

// ── Types ────────────────────────────────────────────────────────────────────
interface CompiledTool {
  id:          string;
  sessionId:   string;
  repoUrl:     string;
  toolName:    string;
  description: string;
  /** OpenAPI-compliant parameter schema */
  schema:      OpenAPIToolSchema;
  /** Detected execution method */
  entrypoint:  string;
  language:    string;
  dependencies: string[];
  compiledAt:  string;
}

interface OpenAPIToolSchema {
  name:        string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required:   string[];
  };
}

// In-process compiled tool registry
const _compiledTools: Map<string, CompiledTool[]> = new Map();

// ── GET — list compiled tools ────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? '';
  return NextResponse.json(_compiledTools.get(sessionId) ?? []);
}

// ── POST — compile a repo into a tool ────────────────────────────────────────
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = rateLimit(ip, 'github-compiler', 10, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${rl.retryAfter}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  let body: { repoUrl?: string; sessionId?: string; toolName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { repoUrl, sessionId, toolName } = body;
  if (!repoUrl || !sessionId) {
    return NextResponse.json({ error: 'repoUrl and sessionId are required' }, { status: 400 });
  }

  // Validate GitHub URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(repoUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (parsedUrl.hostname !== 'github.com') {
    return NextResponse.json({ error: 'Only github.com repositories are supported' }, { status: 400 });
  }

  const pathParts = parsedUrl.pathname.replace(/^\//, '').split('/').filter(Boolean);
  if (pathParts.length < 2) {
    return NextResponse.json({ error: 'URL must point to a repository (github.com/owner/repo)' }, { status: 400 });
  }

  const [owner, repo] = pathParts;

  try {
    // ── Phase 1: Clone — fetch repo tree ──────────────────────────────────
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'MonicaAgentCompiler/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!treeRes.ok) {
      return NextResponse.json(
        { error: `GitHub API error: ${treeRes.status} ${treeRes.statusText}` },
        { status: 502 },
      );
    }

    const treeData = await treeRes.json();
    const files: string[] = (treeData.tree ?? []).map((f: { path: string }) => f.path);

    // ── Phase 2: Parse — extract structural definitions ────────────────────
    const language    = detectLanguage(files);
    const entrypoint  = detectEntrypoint(files, language);
    const dependencies = await fetchDependencies(owner, repo, language);

    // Fetch README for description extraction
    let readmeText = '';
    try {
      const readmeRes = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (readmeRes.ok) {
        const raw = await readmeRes.text();
        readmeText = raw.slice(0, 4000);
      }
    } catch { /* README not found */ }

    // Extract CLI commands and exported functions from README
    const cliCommands  = extractCliCommands(readmeText);
    const description  = extractDescription(readmeText, repo);
    const toolParams   = buildToolParameters(cliCommands, language, files);

    // ── Phase 3: Compile — package as OpenAPI tool schema ─────────────────
    const derivedName = toolName || slugify(repo);
    const schema: OpenAPIToolSchema = {
      name:        derivedName,
      description: description,
      parameters: {
        type:       'object',
        properties: toolParams.properties,
        required:   toolParams.required,
      },
    };

    const compiled: CompiledTool = {
      id:           `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      repoUrl,
      toolName:     derivedName,
      description,
      schema,
      entrypoint,
      language,
      dependencies: dependencies.slice(0, 20),
      compiledAt:   new Date().toISOString(),
    };

    // Register in session tool store
    const existing = _compiledTools.get(sessionId) ?? [];
    _compiledTools.set(sessionId, [...existing, compiled]);

    return NextResponse.json(compiled);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Compilation failed';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectLanguage(files: string[]): string {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const ext = f.split('.').pop()?.toLowerCase() ?? '';
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  // Prioritised language detection
  if (counts['py'])  return 'python';
  if (counts['ts'] || counts['tsx']) return 'typescript';
  if (counts['js'] || counts['jsx']) return 'javascript';
  if (counts['go'])  return 'go';
  if (counts['rs'])  return 'rust';
  if (counts['rb'])  return 'ruby';
  if (counts['java']) return 'java';
  return 'unknown';
}

function detectEntrypoint(files: string[], language: string): string {
  const candidates: Record<string, string[]> = {
    python:     ['main.py', 'app.py', 'cli.py', 'run.py', '__main__.py'],
    typescript: ['src/index.ts', 'index.ts', 'src/main.ts', 'main.ts'],
    javascript: ['src/index.js', 'index.js', 'src/main.js', 'main.js'],
    go:         ['main.go', 'cmd/main.go'],
    rust:       ['src/main.rs'],
    ruby:       ['lib/main.rb', 'bin/run'],
    java:       ['src/main/java/Main.java'],
  };

  const langs = candidates[language] ?? [];
  for (const candidate of langs) {
    if (files.includes(candidate)) return candidate;
  }
  return files.find(f => f.includes('main') || f.includes('index')) ?? 'unknown';
}

async function fetchDependencies(owner: string, repo: string, language: string): Promise<string[]> {
  const depFiles: Record<string, string> = {
    python:     'requirements.txt',
    typescript: 'package.json',
    javascript: 'package.json',
    go:         'go.mod',
    rust:       'Cargo.toml',
    ruby:       'Gemfile',
    java:       'pom.xml',
  };

  const depFile = depFiles[language];
  if (!depFile) return [];

  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${depFile}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const text = await res.text();
    return parseDependencies(text, language);
  } catch {
    return [];
  }
}

function parseDependencies(text: string, language: string): string[] {
  if (language === 'python') {
    return text
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => l.split('==')[0].split('>=')[0].trim())
      .filter(Boolean);
  }
  if (language === 'typescript' || language === 'javascript') {
    try {
      const pkg = JSON.parse(text);
      return [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
    } catch { return []; }
  }
  return [];
}

function extractCliCommands(readme: string): string[] {
  const commands: string[] = [];
  const lines = readme.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Detect code blocks with CLI commands
    if (line.startsWith('```') || line.match(/^\$\s+/) || line.match(/^python\s+/) || line.match(/^npx\s+/)) {
      const cmd = line.replace(/^```(bash|sh)?/, '').replace(/^\$\s+/, '').trim();
      if (cmd) commands.push(cmd);
    }
  }
  return commands.slice(0, 10);
}

function extractDescription(readme: string, repoName: string): string {
  const lines = readme.split('\n').filter(l => l.trim());
  // First non-header line after the title
  for (let i = 1; i < Math.min(10, lines.length); i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#') && !line.startsWith('!') && line.length > 20) {
      return line.replace(/[*_`]/g, '').slice(0, 200);
    }
  }
  return `Compiled tool from ${repoName} GitHub repository.`;
}

function buildToolParameters(
  cliCommands: string[],
  language: string,
  files: string[],
): { properties: Record<string, { type: string; description: string }>; required: string[] } {
  const properties: Record<string, { type: string; description: string }> = {
    command: {
      type:        'string',
      description: `The command or operation to execute. Available commands: ${cliCommands.slice(0, 5).join(', ') || 'see README'}`,
    },
    args: {
      type:        'string',
      description: 'Optional arguments to pass to the command (space-separated)',
    },
  };

  // Add input_file if the repo likely processes files
  const hasFileOps = files.some(f =>
    f.includes('read') || f.includes('process') || f.includes('parse') || f.includes('convert'),
  );
  if (hasFileOps) {
    properties['input'] = {
      type:        'string',
      description: 'Input data or file content to process',
    };
  }

  return { properties, required: ['command'] };
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
