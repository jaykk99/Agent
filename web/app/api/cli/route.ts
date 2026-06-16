/**
 * web/app/api/cli/route.ts
 *
 * Headless CLI execution layer for the Agent.
 * Tools: gh, rg, fd, git, jq, node, npx, vercel, supabase, curl,
 *        grep, ls, cat, head, tail, wc, diff, python3, go, docker
 *
 * POST /api/cli  { tool, args: string[], timeout?: number, github_token?: string }
 * GET  /api/cli  — list available vs missing tools with install hints
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

const execAsync = promisify(exec);

const ALLOWED_TOOLS = new Set([
  'gh', 'git', 'rg', 'fd', 'find',
  'docker', 'docker-compose',
  'vercel', 'supabase',
  'node', 'npx', 'npm',
  'curl', 'wget',
  'jq', 'grep', 'sed', 'awk',
  'ls', 'cat', 'head', 'tail', 'wc', 'diff',
  'echo', 'env', 'which', 'uname',
  'python3', 'pip3',
  'go', 'cargo',
]);

// Explicit dangerous patterns — reject these args outright
const BLOCKED_ARGS = [
  'rm -rf /',
  'sudo rm',
  '/dev/sda',
  '/etc/shadow',
  '/etc/passwd',
];

function isSafe(tool: string, args: string[]): { ok: boolean; reason?: string } {
  if (!ALLOWED_TOOLS.has(tool)) {
    return { ok: false, reason: `Tool '${tool}' is not in the allowed list. Allowed: ${[...ALLOWED_TOOLS].join(', ')}` };
  }
  const full = args.join(' ');
  for (const blocked of BLOCKED_ARGS) {
    if (full.includes(blocked)) {
      return { ok: false, reason: `Blocked argument pattern: "${blocked}"` };
    }
  }
  return { ok: true };
}

async function checkAvailable(tool: string): Promise<boolean> {
  try {
    await execAsync(`which ${tool}`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function buildEnv(tool: string, userGhToken?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tool === 'gh' || tool === 'git') {
    const token = userGhToken || process.env.GITHUB_TOKEN || '';
    if (token) {
      env.GH_TOKEN = token;
      env.GITHUB_TOKEN = token;
    }
  }
  if (tool === 'vercel') {
    env.VERCEL_TOKEN = env.VERCEL_TOKEN || '';
  }
  return env;
}

// ── POST /api/cli — execute a CLI tool ──────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tool, args = [], timeout = 20000, github_token } = body;

    if (!tool) {
      return NextResponse.json({ error: 'tool is required' }, { status: 400 });
    }
    if (!Array.isArray(args)) {
      return NextResponse.json({ error: 'args must be an array of strings' }, { status: 400 });
    }

    const safety = isSafe(tool, args);
    if (!safety.ok) {
      return NextResponse.json({ error: safety.reason }, { status: 403 });
    }

    const available = await checkAvailable(tool);
    if (!available) {
      return NextResponse.json({
        success: false,
        available: false,
        error: `'${tool}' is not installed on this server`,
        hint: getInstallHint(tool),
      }, { status: 422 });
    }

    // Build command string safely — quote each arg
    const quotedArgs = args.map((a: string) => `"${String(a).replace(/"/g, '\\"')}"`);
    const cmdStr = [tool, ...quotedArgs].join(' ');

    const { stdout, stderr } = await execAsync(cmdStr, {
      timeout: Math.min(timeout, 60000),
      env: buildEnv(tool, github_token),
      cwd: '/tmp',
      maxBuffer: 4 * 1024 * 1024, // 4MB
    });

    const out = stdout?.trim() || '';
    const err = stderr?.trim() || '';

    return NextResponse.json({
      success: true,
      stdout: out,
      stderr: err,
      output: out || err || '(command ran with no output)',
      tool,
      args,
    });

  } catch (e: unknown) {
    const ex = e as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    if (ex.killed || ex.message?.includes('ETIMEDOUT')) {
      return NextResponse.json({
        success: false,
        output: `Command timed out`,
        stdout: ex.stdout?.trim() || '',
        stderr: ex.stderr?.trim() || '',
        exit_code: -1,
      });
    }
    // Non-zero exit code — still return output (rg returns 1 for no matches)
    return NextResponse.json({
      success: ex.code === 0 || ex.code == null,
      stdout: ex.stdout?.trim() || '',
      stderr: ex.stderr?.trim() || '',
      output: ex.stdout?.trim() || ex.stderr?.trim() || ex.message || 'Unknown error',
      exit_code: ex.code ?? 1,
    });
  }
}

// ── GET /api/cli — list available/missing tools ───────────────────────────
export async function GET() {
  const toolList = [...ALLOWED_TOOLS];
  const checks = await Promise.all(
    toolList.map(async (t) => ({ tool: t, available: await checkAvailable(t) }))
  );

  const available = checks.filter(c => c.available).map(c => c.tool);
  const missing = checks.filter(c => !c.available).map(c => ({
    tool: c.tool,
    hint: getInstallHint(c.tool),
  }));

  return NextResponse.json({ available, missing, total: toolList.length });
}

function getInstallHint(tool: string): string {
  const hints: Record<string, string> = {
    gh: 'Dockerfile: RUN (type -p wget >/dev/null || apt-get install wget -y) && mkdir -p -m 755 /etc/apt/keyrings && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt-get update && apt-get install gh -y',
    rg: 'Dockerfile: RUN apt-get install -y ripgrep',
    fd: 'Dockerfile: RUN apt-get install -y fd-find && ln -sf /usr/bin/fdfind /usr/bin/fd',
    jq: 'Dockerfile: RUN apt-get install -y jq',
    docker: 'Docker is not available in serverless environments. Use a self-hosted deployment.',
    vercel: 'RUN npm install -g vercel',
    supabase: 'RUN npm install -g supabase',
  };
  return hints[tool] || `Install: apt-get install ${tool}  OR  npm install -g ${tool}`;
}
