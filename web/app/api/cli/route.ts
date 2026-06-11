/**
 * web/app/api/cli/route.ts
 * Headless CLI execution layer — gh, rg, fd, git, docker, vercel, supabase, node, jq and more.
 * POST /api/cli  { tool, args[], timeout?, github_token? }
 * GET  /api/cli  — list available vs missing tools
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

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

const BLOCKED_ARGS = ['rm -rf /', 'sudo rm', '/etc/shadow', '/dev/sda'];

function isSafe(tool: string, args: string[]): { ok: boolean; reason?: string } {
  if (!ALLOWED_TOOLS.has(tool)) return { ok: false, reason: `Tool '${tool}' not in allowed list` };
  const full = args.join(' ');
  for (const b of BLOCKED_ARGS) {
    if (full.includes(b)) return { ok: false, reason: `Blocked argument: ${b}` };
  }
  return { ok: true };
}

async function checkAvailable(tool: string): Promise<boolean> {
  try { await execAsync(`which ${tool}`, { timeout: 2000 }); return true; } catch { return false; }
}

function buildEnv(tool: string, userGhToken?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tool === 'gh' || tool === 'git') {
    const token = userGhToken || process.env.GITHUB_TOKEN || '';
    if (token) { env.GH_TOKEN = token; env.GITHUB_TOKEN = token; }
  }
  return env;
}

export async function POST(req: NextRequest) {
  try {
    const { tool, args = [], timeout = 20000, github_token } = await req.json();
    if (!tool) return NextResponse.json({ error: 'tool is required' }, { status: 400 });

    const safety = isSafe(tool, args);
    if (!safety.ok) return NextResponse.json({ error: safety.reason }, { status: 403 });

    const available = await checkAvailable(tool);
    if (!available) {
      return NextResponse.json({
        error: `'${tool}' is not installed on this server`,
        hint: getInstallHint(tool),
        available: false,
      }, { status: 422 });
    }

    const cmdStr = [tool, ...args].join(' ');
    const { stdout, stderr } = await execAsync(cmdStr, {
      timeout,
      env: buildEnv(tool, github_token),
      cwd: '/tmp',
      maxBuffer: 4 * 1024 * 1024,
    });

    return NextResponse.json({
      success: true,
      stdout: stdout?.trim() || '',
      stderr: stderr?.trim() || '',
      output: stdout?.trim() || stderr?.trim() || '(no output)',
      tool, args,
    });

  } catch (e: unknown) {
    const ex = e as Error & { stdout?: string; stderr?: string; code?: number };
    return NextResponse.json({
      success: false,
      stdout: ex.stdout?.trim() || '',
      stderr: ex.stderr?.trim() || '',
      output: ex.stderr?.trim() || ex.message || 'Unknown error',
      exit_code: ex.code ?? 1,
    });
  }
}

export async function GET() {
  const checks = await Promise.all(
    [...ALLOWED_TOOLS].map(async t => ({ tool: t, available: await checkAvailable(t) }))
  );
  return NextResponse.json({
    available: checks.filter(c => c.available).map(c => c.tool),
    missing: checks.filter(c => !c.available).map(c => c.tool),
  });
}

function getInstallHint(tool: string): string {
  const hints: Record<string, string> = {
    gh: 'Dockerfile: RUN apt-get install -y gh  |  https://cli.github.com/',
    rg: 'Dockerfile: RUN apt-get install -y ripgrep',
    fd: 'Dockerfile: RUN apt-get install -y fd-find && ln -s /usr/bin/fdfind /usr/bin/fd',
    docker: 'Not available in serverless — use a self-hosted deployment',
    vercel: 'RUN npm i -g vercel',
    supabase: 'RUN npm i -g supabase',
    jq: 'RUN apt-get install -y jq',
  };
  return hints[tool] || `apt-get install ${tool}  or  npm i -g ${tool}`;
}
