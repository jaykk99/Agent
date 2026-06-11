import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { executeMcpFunction, MCP_MANAGEMENT_TOOLS } from '../mcp/route';

const execAsync = promisify(exec);

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

const SYSTEM_INSTRUCTION = `You are an elite AI software engineer with live, authenticated access to GitHub repositories, Supabase databases, and Vercel deployments. You think deeply, write production-quality code, and always complete tasks end-to-end without asking the user to do anything manually.

## CORE RULES (never break these)
1. NEVER say "I cannot access", "you'll need to", "copy and paste", or "manually edit". You have the tools — use them.
2. ALWAYS read a file before writing it (to get the current SHA). Writing without SHA overwrites silently wrong.
3. When the user mentions "my repo" or "my repository", use list_github_directory on the repos you know about — start with the most recently mentioned or most relevant one. NEVER ask for the owner/repo name if GitHub is connected.
4. After every task, tell the user exactly what changed: which files, what was added/removed/fixed.
5. Explore before acting. Use list_github_directory("") to understand structure, then drill down.
6. Write complete files, not diffs. Always replace the entire file content.
7. Use descriptive, conventional commit messages (feat:, fix:, refactor:, etc.)

## INTELLIGENCE RULES
- Think step by step before coding. Consider edge cases, error handling, and maintainability.
- When fixing bugs, read the problematic file first to understand context.
- When adding features, read related files to maintain consistency in style/patterns.
- Prefer small focused commits. Don't change unrelated things.
- If you encounter an error from a tool, diagnose it intelligently — don't just retry.

## GITHUB WORKFLOW
- Start exploration: list_github_directory with repo="jaykk99/<repo>" and path=""
- Read files: read_github_file to see full content + get SHA
- Write files: write_github_file with the complete new content + SHA from read step
- Default repo: jaykk99/Agent (the repository this code lives in)
- Other known repos: jaykk99/monico-agent

## CAPABILITIES
- Full GitHub CRUD on any accessible repository
- Supabase: query, insert, update, delete rows; list tables
- Vercel: list projects/deployments, manage env vars, trigger redeploys
- Shell: run npm, git, curl, and other CLI tools
- Web search (when enabled): find documentation, packages, solutions

## PERSONALITY
You are confident, precise, and efficient. You get things done. When something is ambiguous, make a reasonable assumption and state it clearly. Never hedge or add unnecessary caveats.`;

const GITHUB_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_github_directory',
      description: 'List files and folders in a GitHub repository directory. Use this to explore the repo structure before making changes.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in format owner/repo, e.g. jaykk99/Agent' },
          path: { type: 'string', description: 'Directory path. Use empty string for the root directory.' }
        },
        required: ['repo']
      }
    },
    {
      name: 'read_github_file',
      description: 'Read the full content of a specific file from a GitHub repository. Returns content and SHA (needed for updates).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in format owner/repo' },
          path: { type: 'string', description: 'File path, e.g. "src/index.ts" or "README.md"' }
        },
        required: ['repo', 'path']
      }
    },
    {
      name: 'write_github_file',
      description: 'Create a new file or update an existing file in a GitHub repository. ALWAYS read the file first to get the SHA before updating. Never ask the user to do this manually.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in format owner/repo' },
          path: { type: 'string', description: 'File path to create or update' },
          content: { type: 'string', description: 'Complete new file content (entire file, not a diff)' },
          message: { type: 'string', description: 'Git commit message describing what was changed and why' },
          sha: { type: 'string', description: 'Current file SHA from read_github_file (required when updating existing file; omit only for brand new files)' },
          branch: { type: 'string', description: 'Branch to commit to, defaults to the repo default branch (usually main or master)' }
        },
        required: ['repo', 'path', 'content', 'message']
      }
    },
    {
      name: 'run_shell_command',
      description: 'Execute a shell command in the server environment. Useful for npm, yarn, git, or other CLI tools. Commands run in /tmp.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute, e.g. "npm --version" or "git --version"' }
        },
        required: ['command']
      }
    }
  ]
};

const SUPABASE_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_supabase_tables',
      description: 'List all tables in the connected Supabase project.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'query_supabase',
      description: 'Run a SELECT query against a Supabase table. Returns rows as JSON.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to query' },
          select: { type: 'string', description: 'Columns to select, e.g. "*" or "id,name,email"' },
          filter: { type: 'string', description: 'Optional PostgREST filter, e.g. "status=eq.active&limit=20"' }
        },
        required: ['table']
      }
    },
    {
      name: 'insert_supabase_row',
      description: 'Insert a new row into a Supabase table.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          data: { type: 'string', description: 'JSON object of column:value pairs to insert' }
        },
        required: ['table', 'data']
      }
    },
    {
      name: 'update_supabase_rows',
      description: 'Update rows in a Supabase table matching a filter.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          filter: { type: 'string', description: 'PostgREST filter to match rows, e.g. "id=eq.5"' },
          data: { type: 'string', description: 'JSON object of column:value pairs to update' }
        },
        required: ['table', 'filter', 'data']
      }
    },
    {
      name: 'delete_supabase_rows',
      description: 'Delete rows from a Supabase table matching a filter.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          filter: { type: 'string', description: 'PostgREST filter to identify rows to delete, e.g. "id=eq.5"' }
        },
        required: ['table', 'filter']
      }
    }
  ]
};

const VERCEL_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_vercel_projects',
      description: 'List all Vercel projects in the connected account.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'list_vercel_deployments',
      description: 'List recent deployments for a Vercel project.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Vercel project ID or name' },
          limit: { type: 'string', description: 'Number of deployments to return (default 10)' }
        },
        required: ['projectId']
      }
    },
    {
      name: 'get_vercel_env_vars',
      description: 'List environment variables for a Vercel project (values are redacted for security).',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Vercel project ID or name' }
        },
        required: ['projectId']
      }
    },
    {
      name: 'add_vercel_env_var',
      description: 'Add or update an environment variable in a Vercel project.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Vercel project ID or name' },
          key: { type: 'string', description: 'Environment variable name' },
          value: { type: 'string', description: 'Environment variable value' },
          target: { type: 'string', description: 'Deployment targets: "production", "preview", "development" (comma-separated for multiple)' }
        },
        required: ['projectId', 'key', 'value']
      }
    },
    {
      name: 'trigger_vercel_redeploy',
      description: 'Trigger a redeployment of the latest production deployment for a Vercel project.',
      parameters: {
        type: 'object',
        properties: {
          deploymentId: { type: 'string', description: 'Deployment ID to redeploy' }
        },
        required: ['deploymentId']
      }
    }
  ]
};


async function executeGithubFunction(name: string, args: Record<string, string>, userGhToken?: string): Promise<string> {
  // Use user's OAuth token (from settings) first, fall back to server GITHUB_TOKEN
  const token = userGhToken || process.env.GITHUB_TOKEN;
  if (!token && name !== 'run_shell_command') return 'Error: GitHub is not connected. Go to Integrations tab and connect GitHub first.';

  try {
    if (name === 'list_github_directory') {
      const { repo, path = '' } = args;
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'AIAgent' }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return `Error listing directory: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        const lines = data.map((f: { name: string; type: string; size: number }) =>
          `${f.type === 'dir' ? '📁' : '📄'} ${f.name}${f.type === 'file' ? ` (${f.size} bytes)` : ''}`
        );
        return `Directory: /${path || ''}\n${lines.join('\n')}`;
      }
      return JSON.stringify(data);
    }

    if (name === 'read_github_file') {
      const { repo, path } = args;
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'AIAgent' }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return `Error reading file: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return `path: ${data.path}\nsha: ${data.sha}\nsize: ${data.size} bytes\n\n---FILE CONTENT---\n${content}\n---END---`;
      }
      if (Array.isArray(data)) return `That path is a directory. Use list_github_directory instead.`;
      return 'File has no readable content';
    }

    if (name === 'write_github_file') {
      const { repo, path, content, message, sha, branch } = args;
      const body: Record<string, string> = {
        message,
        content: Buffer.from(content, 'utf-8').toString('base64')
      };
      if (sha) body.sha = sha;
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return `Error writing file: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      return `✅ ${sha ? 'Updated' : 'Created'} ${path} — commit: ${data.commit?.sha?.slice(0, 7)} — ${data.content?.html_url}`;
    }

    if (name === 'run_shell_command') {
      const { command } = args;
      const blocked = ['rm -rf /', 'sudo rm', 'mkfs', ':(){', 'chmod 777 /', '> /dev/sda'];
      for (const b of blocked) {
        if (command.includes(b)) return `Blocked: "${b}" is not permitted`;
      }
      const { stdout, stderr } = await execAsync(command, { timeout: 15000, cwd: '/tmp' });
      const out = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
      return out || '(command ran with no output)';
    }

    return `Unknown function: ${name}`;
  } catch (e) {
    return `Execution error: ${e instanceof Error ? e.message : 'Unknown error'}`;
  }
}

async function executeSupabaseFunction(name: string, args: Record<string, string>, sbToken: string, sbUrl: string): Promise<string> {
  if (!sbToken) return 'Error: Not connected to Supabase. Please sign in via Integrations → Connect Supabase.';
  const base = sbUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  if (!base) return 'Error: Supabase URL not configured.';
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${sbToken}`,
    'apikey': sbToken,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    if (name === 'list_supabase_tables') {
      const res = await fetch(`${base}/rest/v1/?apikey=${sbToken}`, { headers });
      if (!res.ok) return `Error: ${res.status} ${res.statusText}`;
      const data = await res.json();
      const tables = Object.keys(data?.definitions || {});
      return tables.length ? `Tables: ${tables.join(', ')}` : 'No tables found (or insufficient permissions)';
    }

    if (name === 'query_supabase') {
      const { table, select = '*', filter = '' } = args;
      const url = `${base}/rest/v1/${table}?select=${select}${filter ? '&' + filter : ''}`;
      const res = await fetch(url, { headers });
      if (!res.ok) { const e = await res.text(); return `Error querying ${table}: ${e}`; }
      const rows = await res.json();
      return JSON.stringify(rows, null, 2);
    }

    if (name === 'insert_supabase_row') {
      const { table, data } = args;
      let parsed: object;
      try { parsed = JSON.parse(data); } catch { return 'Error: data must be valid JSON'; }
      const res = await fetch(`${base}/rest/v1/${table}`, {
        method: 'POST', headers, body: JSON.stringify(parsed)
      });
      if (!res.ok) { const e = await res.text(); return `Error inserting into ${table}: ${e}`; }
      const result = await res.json();
      return `✅ Inserted: ${JSON.stringify(result)}`;
    }

    if (name === 'update_supabase_rows') {
      const { table, filter, data } = args;
      let parsed: object;
      try { parsed = JSON.parse(data); } catch { return 'Error: data must be valid JSON'; }
      const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
        method: 'PATCH', headers, body: JSON.stringify(parsed)
      });
      if (!res.ok) { const e = await res.text(); return `Error updating ${table}: ${e}`; }
      const result = await res.json();
      return `✅ Updated: ${JSON.stringify(result)}`;
    }

    if (name === 'delete_supabase_rows') {
      const { table, filter } = args;
      const res = await fetch(`${base}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers });
      if (!res.ok) { const e = await res.text(); return `Error deleting from ${table}: ${e}`; }
      return `✅ Deleted rows matching: ${filter}`;
    }

    return `Unknown Supabase function: ${name}`;
  } catch (e) {
    return `Supabase error: ${e instanceof Error ? e.message : 'Unknown'}`;
  }
}

async function executeVercelFunction(name: string, args: Record<string, string>, vrToken: string): Promise<string> {
  if (!vrToken) return 'Error: Not connected to Vercel. Please sign in via Integrations → Connect Vercel.';
  const headers = { 'Authorization': `Bearer ${vrToken}`, 'Content-Type': 'application/json' };

  try {
    if (name === 'list_vercel_projects') {
      const res = await fetch('https://api.vercel.com/v9/projects?limit=20', { headers });
      if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
      const data = await res.json();
      const projects = (data.projects || []).map((p: { id: string; name: string; framework: string }) =>
        `${p.name} (id: ${p.id}, framework: ${p.framework || 'static'})`
      );
      return projects.length ? projects.join('\n') : 'No projects found';
    }

    if (name === 'list_vercel_deployments') {
      const { projectId, limit = '10' } = args;
      const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=${limit}`, { headers });
      if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
      const data = await res.json();
      const deps = (data.deployments || []).map((d: { uid: string; url: string; state: string; createdAt: number; meta?: { githubCommitMessage?: string } }) =>
        `${d.uid} | ${d.state} | ${new Date(d.createdAt).toISOString().slice(0, 16)} | ${d.url} | ${d.meta?.githubCommitMessage || ''}`
      );
      return deps.length ? deps.join('\n') : 'No deployments found';
    }

    if (name === 'get_vercel_env_vars') {
      const { projectId } = args;
      const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env`, { headers });
      if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
      const data = await res.json();
      const envs = (data.envs || []).map((e: { key: string; target: string[]; type: string }) =>
        `${e.key} [${e.target?.join(',')}] (${e.type})`
      );
      return envs.length ? envs.join('\n') : 'No env vars found';
    }

    if (name === 'add_vercel_env_var') {
      const { projectId, key, value, target = 'production,preview' } = args;
      const targets = target.split(',').map(t => t.trim());
      const body = { key, value, target: targets, type: 'plain' };
      const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
      return `✅ Added env var ${key} to project ${projectId}`;
    }

    if (name === 'trigger_vercel_redeploy') {
      const { deploymentId } = args;
      const res = await fetch(`https://api.vercel.com/v13/deployments?forceNew=1`, {
        method: 'POST', headers,
        body: JSON.stringify({ deploymentId, name: deploymentId })
      });
      if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
      const data = await res.json();
      return `✅ Redeployment triggered: ${data.id} — ${data.url}`;
    }

    return `Unknown Vercel function: ${name}`;
  } catch (e) {
    return `Vercel error: ${e instanceof Error ? e.message : 'Unknown'}`;
  }
}

// ── CLI Tool Declarations ─────────────────────────────────────────────────────
const CLI_TOOLS = {
  functionDeclarations: [
    {
      name: 'run_cli',
      description: "Run a headless CLI tool (gh, rg, fd, git, jq, node, vercel, supabase, curl, grep, ls, cat, diff) on the server. Use for: creating GitHub PRs/issues, searching code with ripgrep, file discovery with fd, JSON transforms with jq, git operations. Pass args as a JSON array string.",
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: "CLI binary: 'gh', 'rg', 'fd', 'git', 'jq', 'node', 'vercel', 'supabase', 'curl', 'ls', 'cat', 'grep', 'diff'" },
          args: { type: 'string', description: 'JSON array of CLI arguments, e.g. ["pr","create","--title","feat: X","--repo","jaykk99/Agent"]' },
          timeout: { type: 'string', description: 'Timeout ms (default 20000)' }
        },
        required: ['tool', 'args']
      }
    },
    {
      name: 'list_cli_tools',
      description: 'List all CLI tools available on the server — which are installed vs missing with install hints.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'gh_create_pr',
      description: 'Create a structured GitHub Pull Request. Formats title, body, base branch automatically using gh CLI.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo e.g. jaykk99/Agent' },
          title: { type: 'string', description: 'PR title (conventional commits: feat:, fix:, refactor:)' },
          body: { type: 'string', description: 'PR body with ## What, ## Why, ## Changes, ## Testing sections' },
          base: { type: 'string', description: 'Base branch (default: main)' },
          head: { type: 'string', description: 'Head branch with changes' }
        },
        required: ['repo', 'title', 'body']
      }
    },
    {
      name: 'gh_create_issue',
      description: 'Create a structured GitHub Issue (bug or feature). Formats body with proper sections and labels.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body — bugs: Steps/Expected/Actual/Environment; features: Problem/Solution/Acceptance Criteria' },
          labels: { type: 'string', description: 'Comma-separated labels e.g. "bug,priority:high"' }
        },
        required: ['repo', 'title', 'body']
      }
    },
    {
      name: 'rg_search',
      description: 'Fast regex search across the codebase using ripgrep. Returns file:line matches. Use for: finding variable usages, locating TODOs, discovering function signatures, understanding patterns.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern, e.g. "useState|useEffect" or "async function"' },
          path: { type: 'string', description: 'Directory to search (default: .)' },
          file_type: { type: 'string', description: 'File type filter: "ts", "tsx", "js", "py", "json"' },
          context_lines: { type: 'string', description: 'Context lines around each match (default: 0)' }
        },
        required: ['pattern']
      }
    },
    {
      name: 'fd_find',
      description: 'Find files by name or extension using fd (faster than find). Use for: locating config files, finding all files of a type, discovering project structure.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Filename pattern e.g. "route.ts" or a regex' },
          path: { type: 'string', description: 'Directory to search in (default: .)' },
          extension: { type: 'string', description: 'Extension filter e.g. "ts", "json", "md"' }
        },
        required: ['pattern']
      }
    },
    {
      name: 'what_the_diff',
      description: 'Generate a natural-language explanation of a git diff or code change. Pass the diff output and get a plain-English structural summary of what changed and why it matters.',
      parameters: {
        type: 'object',
        properties: {
          diff_text: { type: 'string', description: 'The git diff output or code comparison to explain' }
        },
        required: ['diff_text']
      }
    }
  ]
};


// Build Gemini-compatible tools array (search + function declarations can coexist)
function buildTools(useSearch: boolean, hasSb: boolean, hasVr: boolean) {
  const tools: object[] = [GITHUB_TOOLS, MCP_MANAGEMENT_TOOLS];  // MCP always enabled
  if (hasSb) tools.push(SUPABASE_TOOLS);
  if (hasVr) tools.push(VERCEL_TOOLS);
  if (useSearch) tools.push({ google_search: {} });
  return tools;
}

async function callGemini(apiKey: string, model: string, contents: object[], useSearch: boolean, hasSb = false, hasVr = false, systemInst?: string) {
  const body = {
    system_instruction: { parts: [{ text: systemInst || SYSTEM_INSTRUCTION }] },
    contents,
    tools: buildTools(useSearch, hasSb, hasVr),
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
  };

  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
}

// ── CLI tool executor ─────────────────────────────────────────────────────────
async function executeCliFunction(name: string, args: Record<string, string>, userGhToken?: string): Promise<string> {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const ghToken = userGhToken || process.env.GITHUB_TOKEN || '';

  try {
    if (name === 'list_cli_tools') {
      const res = await fetch(`${baseUrl}/api/cli`, { method: 'GET' });
      if (!res.ok) return `Error listing CLI tools: ${res.status}`;
      const data = await res.json();
      const avail = (data.available || []).join(', ');
      const miss  = (data.missing  || []).join(', ');
      return `✅ Available: ${avail || 'none'}\n❌ Missing: ${miss || 'none'}`;
    }

    if (name === 'run_cli') {
      const { tool, args: argsStr, timeout } = args;
      let parsedArgs: string[] = [];
      try { parsedArgs = JSON.parse(argsStr || '[]'); } catch { parsedArgs = (argsStr || '').split(' ').filter(Boolean); }
      const res = await fetch(`${baseUrl}/api/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args: parsedArgs, timeout: parseInt(timeout || '20000'), github_token: ghToken }),
      });
      const data = await res.json();
      if (!res.ok) return `❌ ${data.error || 'CLI error'}${data.hint ? '\nHint: ' + data.hint : ''}`;
      return data.output || data.stdout || '(no output)';
    }

    if (name === 'gh_create_pr') {
      const { repo, title, body, base = 'main', head } = args;
      const ghArgs = ['pr', 'create', '--repo', repo, '--title', title, '--body', body, '--base', base];
      if (head) ghArgs.push('--head', head);
      const res = await fetch(`${baseUrl}/api/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'gh', args: ghArgs, github_token: ghToken }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return `❌ PR creation failed: ${data.output || data.error}\nHint: ${data.hint || 'Ensure gh is installed and GitHub token has repo scope'}`;
      return `✅ PR created!\n${data.output}`;
    }

    if (name === 'gh_create_issue') {
      const { repo, title, body, labels } = args;
      const ghArgs = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
      if (labels) ghArgs.push('--label', labels);
      const res = await fetch(`${baseUrl}/api/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'gh', args: ghArgs, github_token: ghToken }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return `❌ Issue creation failed: ${data.output || data.error}`;
      return `✅ Issue created!\n${data.output}`;
    }

    if (name === 'rg_search') {
      const { pattern, path: searchPath = '.', file_type, context_lines = '0' } = args;
      const rgArgs = [pattern, searchPath || '.', '--max-count', '50'];
      if (file_type) rgArgs.push('--type', file_type);
      const ctx = parseInt(context_lines || '0');
      if (ctx > 0) rgArgs.push('-C', String(ctx));
      rgArgs.push('--no-heading', '--line-number');
      const res = await fetch(`${baseUrl}/api/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'rg', args: rgArgs }),
      });
      const data = await res.json();
      if (data.available === false) return `rg (ripgrep) not installed. ${data.hint}\n\nFallback: Use read_github_file to read specific files instead.`;
      return data.output || data.stdout || 'No matches found';
    }

    if (name === 'fd_find') {
      const { pattern, path: searchPath = '.', extension } = args;
      const fdArgs = [pattern || '.'];
      if (searchPath) fdArgs.push(searchPath);
      if (extension) fdArgs.push('--extension', extension);
      fdArgs.push('--max-results', '50');
      const res = await fetch(`${baseUrl}/api/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'fd', args: fdArgs }),
      });
      const data = await res.json();
      if (data.available === false) {
        // Fallback to find
        const findRes = await fetch(`${baseUrl}/api/cli`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'find', args: [searchPath || '.', '-name', `*${pattern}*`, '-type', 'f'] }),
        });
        const findData = await findRes.json();
        return findData.output || 'No files found';
      }
      return data.output || data.stdout || 'No files found';
    }

    if (name === 'what_the_diff') {
      const { diff_text } = args;
      if (!diff_text) return 'No diff provided';
      // Use Gemini itself to explain — return structured prompt result
      const lines = diff_text.split('\n');
      const added   = lines.filter(l => l.startsWith('+')).length;
      const removed = lines.filter(l => l.startsWith('-')).length;
      const files   = [...new Set(lines.filter(l => l.startsWith('+++') || l.startsWith('---')).map(l => l.replace(/^[+-]{3} [ab]?\/?/, '')))];
      return `Diff Analysis:\n- Files changed: ${files.join(', ') || 'unknown'}\n- Lines added: ${added}\n- Lines removed: ${removed}\n\nFull diff passed to model for explanation:\n${diff_text.slice(0, 3000)}`;
    }

    return `Unknown CLI function: ${name}`;
  } catch (e) {
    return `CLI error (${name}): ${e instanceof Error ? e.message : 'Unknown error'}`;
  }
}


export async function POST(req: NextRequest) {
  try {
    const { message, history, settings } = await req.json();

    const apiKey = settings?.is_custom_gemini_key_enabled && settings?.custom_gemini_api_key
      ? settings.custom_gemini_api_key
      : process.env.GEMINI_API_KEY;

    if (!apiKey) return NextResponse.json({ error: 'No Gemini API key configured' }, { status: 400 });

    const useSearch = !!settings?.enable_web_search;
    const sbToken: string = settings?.supabase_access_token || '';
    const sbUrl: string = settings?.supabase_url || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const vrToken: string = settings?.vercel_access_token || '';
    const userGhToken: string = settings?.github_token || '';  // User's OAuth GitHub token
    const hasSb = !!sbToken;
    const hasVr = !!vrToken;
    const requested = settings?.active_model_name || 'gemini-2.5-flash';
    const modelsToTry = [requested, ...FALLBACK_MODELS.filter(m => m !== requested)];

    // Build initial conversation history
    // Inject connected repo context so the model never asks for owner/repo
    let systemWithContext = SYSTEM_INSTRUCTION;
    if (userGhToken && settings?.github_username) {
      systemWithContext += `\n\n## CONNECTED GITHUB ACCOUNT\nUsername: ${settings.github_username}\nDefault repo format: ${settings.github_username}/<repo_name>\nWhen the user says "my repo" or mentions a repo by short name, prepend "${settings.github_username}/" automatically.`;
    }

    const baseContents: object[] = [
      ...(history || []).map((h: { role: string; text: string }) => ({
        role: h.role,
        parts: [{ text: h.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    let usedModel = requested;

    // Try models with fallback
    let geminiRes: Response | null = null;
    for (const model of modelsToTry) {
      const res = await callGemini(apiKey, model, baseContents, useSearch, hasSb, hasVr, systemWithContext);
      if (res.ok) { geminiRes = res; usedModel = model; break; }
      const errText = await res.text();
      let errCode: number | undefined;
      try { errCode = JSON.parse(errText)?.error?.code; } catch { /* ignore */ }
      if (errCode !== 503 && errCode !== 429 && errCode !== 404) {
        return NextResponse.json({ error: errText }, { status: 500 });
      }
    }
    if (!geminiRes) return NextResponse.json({ error: 'All models unavailable' }, { status: 503 });

    // ── Function calling loop ──────────────────────────────────────────────
    let currentContents: object[] = [...baseContents];
    let currentRes = geminiRes;
    const MAX_TURNS = 12;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const geminiData = await currentRes.json();

      if (geminiData.error) {
        return NextResponse.json({ error: geminiData.error.message || 'Gemini error' }, { status: 500 });
      }

      const candidate = geminiData.candidates?.[0];
      const parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, string> } }> = candidate?.content?.parts || [];

      // Find function calls
      const fnCalls = parts.filter(p => p.functionCall);

      if (fnCalls.length === 0) {
        // Terminal turn — assemble final text
        const textParts = parts.filter(p => p.text).map(p => p.text!);
        let text = textParts.join('\n') || 'No response from model.';

        // Model fallback note
        if (usedModel !== requested) {
          text += `\n\n_(used ${usedModel} — ${requested} was temporarily unavailable)_`;
        }

        // Search grounding sources
        const groundingMeta = candidate?.groundingMetadata;
        if (groundingMeta?.groundingChunks?.length) {
          const sources = groundingMeta.groundingChunks
            .slice(0, 5)
            .map((c: { web?: { uri: string; title: string } }) => c.web ? `[${c.web.title || c.web.uri}](${c.web.uri})` : null)
            .filter(Boolean)
            .join(' · ');
          if (sources) text += `\n\n🔍 Sources: ${sources}`;
        }

        return NextResponse.json({ text });
      }

      // Execute all function calls in parallel
      const fnResults = await Promise.all(
        fnCalls.map(async (p) => {
          const fn = p.functionCall!;
          const sbFns = ['list_supabase_tables','query_supabase','insert_supabase_row','update_supabase_rows','delete_supabase_rows'];
          const vrFns = ['list_vercel_projects','list_vercel_deployments','get_vercel_env_vars','add_vercel_env_var','trigger_vercel_redeploy'];
          const mcpFns = ['mcp_list_servers','mcp_call_tool','mcp_fetch_url','mcp_remember','mcp_recall'];
          let result: string;
          if (sbFns.includes(fn.name)) {
            result = await executeSupabaseFunction(fn.name, fn.args || {}, sbToken, sbUrl);
          } else if (vrFns.includes(fn.name)) {
            result = await executeVercelFunction(fn.name, fn.args || {}, vrToken);
          } else if (mcpFns.includes(fn.name)) {
            result = await executeMcpFunction(fn.name, fn.args || {});
          } else {
            result = await executeGithubFunction(fn.name, fn.args || {}, userGhToken);
          }
          return {
            functionResponse: {
              name: fn.name,
              response: { result }
            }
          };
        })
      );

      // Continue conversation with function results
      currentContents = [
        ...currentContents,
        { role: 'model', parts },
        { role: 'user', parts: fnResults }
      ];

      // Next Gemini turn
      currentRes = await callGemini(apiKey, usedModel, currentContents, useSearch, hasSb, hasVr, systemWithContext);
      if (!currentRes.ok) {
        const err = await currentRes.text();
        return NextResponse.json({ error: err }, { status: 500 });
      }
    }

    return NextResponse.json({ error: 'Max function-call iterations reached' }, { status: 500 });

  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}

