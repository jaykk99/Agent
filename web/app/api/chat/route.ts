import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── In-process memory (per cold start; persistent facts go through /api/db/settings) ──
const _agentMemory: Record<string, string> = {};

// ── MCP Tools declaration (inlined — avoids circular import from mcp/route.ts) ──
const MCP_TOOLS = {
  functionDeclarations: [
    {
      name: 'mcp_fetch_url',
      description: 'Fetch any URL and return its readable text content. Use to: read live docs, verify a deployment is up, scrape data from a website, read a GitHub raw file, check an API response.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL including https://' },
          max_length: { type: 'string', description: 'Max chars to return (default 8000)' }
        },
        required: ['url']
      }
    },
    {
      name: 'mcp_remember',
      description: 'Persist a fact/value across this conversation and future ones. Use for: project architecture decisions, preferred branch names, DB schemas, deployment URLs.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name e.g. "preferred_branch" or "db_schema"' },
          value: { type: 'string', description: 'Value to store' }
        },
        required: ['key', 'value']
      }
    },
    {
      name: 'mcp_recall',
      description: 'Retrieve a previously remembered value by key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to retrieve' }
        },
        required: ['key']
      }
    }
  ]
};

// ── GitHub Tools ─────────────────────────────────────────────────────────────
const GITHUB_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_github_directory',
      description: 'List files and folders in a GitHub repository directory. Call this first to explore a repo before reading specific files. Reveals the project structure.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo e.g. "jaykk99/Agent"' },
          path: { type: 'string', description: 'Directory path (empty string for root)' }
        },
        required: ['repo']
      }
    },
    {
      name: 'read_github_file',
      description: 'Read the full content of a file in a GitHub repo. Returns content + SHA (needed for writing). Use this to understand code before modifying it.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          path: { type: 'string', description: 'Full file path e.g. "web/app/api/chat/route.ts"' },
          ref: { type: 'string', description: 'Branch or commit SHA (default: main)' }
        },
        required: ['repo', 'path']
      }
    },
    {
      name: 'write_github_file',
      description: 'Create or update a file in a GitHub repo. ALWAYS read the file first to get its SHA before updating. Write the COMPLETE file content — never truncate.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Complete file content (UTF-8)' },
          message: { type: 'string', description: 'Commit message (conventional: feat:, fix:, refactor:, docs:)' },
          sha: { type: 'string', description: 'Current file SHA (required for updates, omit for new files)' },
          branch: { type: 'string', description: 'Target branch (default: main)' }
        },
        required: ['repo', 'path', 'content', 'message']
      }
    },
    {
      name: 'delete_github_file',
      description: 'Delete a file from a GitHub repo. Requires the current SHA.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          path: { type: 'string', description: 'File path to delete' },
          sha: { type: 'string', description: 'Current file SHA (from read_github_file)' },
          message: { type: 'string', description: 'Commit message' },
          branch: { type: 'string', description: 'Branch (default: main)' }
        },
        required: ['repo', 'path', 'sha', 'message']
      }
    },
    {
      name: 'search_github_code',
      description: 'Search for code across GitHub repositories using GitHub Code Search. Find where a function is defined, how a variable is used, or discover patterns.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query e.g. "executeCliFunction repo:jaykk99/Agent" or "useState language:typescript"' }
        },
        required: ['query']
      }
    },
    {
      name: 'create_github_pr',
      description: 'Create a Pull Request on GitHub. Use after pushing changes to a branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          title: { type: 'string', description: 'PR title (conventional commit format)' },
          body: { type: 'string', description: 'PR description with ## What, ## Why, ## Changes, ## Testing sections' },
          head: { type: 'string', description: 'Branch with changes' },
          base: { type: 'string', description: 'Target branch (default: main)' }
        },
        required: ['repo', 'title', 'body', 'head']
      }
    },
    {
      name: 'create_github_issue',
      description: 'Create a GitHub issue (bug report or feature request).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body with steps to reproduce, expected/actual behavior, environment' },
          labels: { type: 'string', description: 'Comma-separated label names' }
        },
        required: ['repo', 'title', 'body']
      }
    },
    {
      name: 'get_github_commits',
      description: 'Get recent commit history for a repo or file. Useful for understanding what changed recently.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          path: { type: 'string', description: 'Optional: filter to commits touching this file' },
          count: { type: 'string', description: 'Number of commits (default 10)' }
        },
        required: ['repo']
      }
    },
    {
      name: 'get_github_diff',
      description: 'Get the diff of a specific commit or compare two refs. Returns the actual code changes.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          sha: { type: 'string', description: 'Commit SHA, or leave empty and use base+head' },
          base: { type: 'string', description: 'Base ref for comparison' },
          head: { type: 'string', description: 'Head ref for comparison' }
        },
        required: ['repo']
      }
    },
    {
      name: 'run_shell_command',
      description: 'Run a shell command on the server (limited environment). Use for: quick computations, string manipulation, JSON processing, checking Node version. NOT a full system shell — prefer CLI tools for complex ops.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' }
        },
        required: ['command']
      }
    }
  ]
};

// ── Supabase Tools ───────────────────────────────────────────────────────────
const SUPABASE_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_supabase_tables',
      description: 'List all tables in the connected Supabase database.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'query_supabase',
      description: 'Run a SELECT query on a Supabase table with optional filters.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          select: { type: 'string', description: 'Columns to select (default: *)' },
          filter: { type: 'string', description: 'JSON filter object e.g. {"status":"active"}' },
          limit: { type: 'string', description: 'Max rows (default 50)' }
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
          data: { type: 'string', description: 'JSON object with column values' }
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
          filter: { type: 'string', description: 'JSON filter to match rows' },
          data: { type: 'string', description: 'JSON object with new values' }
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
          filter: { type: 'string', description: 'JSON filter to match rows' }
        },
        required: ['table', 'filter']
      }
    }
  ]
};

// ── Vercel Tools ─────────────────────────────────────────────────────────────
const VERCEL_TOOLS = {
  functionDeclarations: [
    {
      name: 'list_vercel_projects',
      description: 'List all Vercel projects for the connected account.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'list_vercel_deployments',
      description: 'List recent deployments for a Vercel project.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Vercel project ID or name' },
          limit: { type: 'string', description: 'Number of deployments (default 5)' }
        },
        required: ['projectId']
      }
    },
    {
      name: 'get_vercel_env_vars',
      description: 'Get environment variables for a Vercel project.',
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
          projectId: { type: 'string', description: 'Vercel project ID' },
          key: { type: 'string', description: 'Variable name' },
          value: { type: 'string', description: 'Variable value' },
          target: { type: 'string', description: 'Comma-separated targets: production,preview,development (default: production,preview)' }
        },
        required: ['projectId', 'key', 'value']
      }
    },
    {
      name: 'trigger_vercel_redeploy',
      description: 'Trigger a new deployment for a Vercel project.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Vercel project ID' },
          deploymentId: { type: 'string', description: 'Deployment ID to redeploy' }
        },
        required: ['projectId']
      }
    }
  ]
};

// ── CLI Tools ─────────────────────────────────────────────────────────────────
const CLI_TOOLS = {
  functionDeclarations: [
    {
      name: 'run_cli',
      description: 'Run a CLI tool on the server (gh, rg, fd, git, jq, node, curl, grep, ls, cat, diff). Pass args as a JSON array. Use this for: creating PRs via gh CLI, ripgrep code search, file discovery.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: "CLI binary: 'gh', 'rg', 'fd', 'git', 'jq', 'node', 'curl', 'ls', 'cat', 'grep', 'diff'" },
          args: { type: 'string', description: 'JSON array of arguments e.g. ["pr","create","--title","feat: X","--repo","owner/repo"]' },
          timeout: { type: 'string', description: 'Timeout ms (default 20000)' }
        },
        required: ['tool', 'args']
      }
    },
    {
      name: 'what_the_diff',
      description: 'Explain a git diff or two code snippets in plain English. Summarizes what changed structurally.',
      parameters: {
        type: 'object',
        properties: {
          diff_text: { type: 'string', description: 'Git diff output or code comparison' }
        },
        required: ['diff_text']
      }
    }
  ]
};

// ── Model configs ─────────────────────────────────────────────────────────────
const FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

const HF_MODELS: Record<string, string> = {
  'hf:Qwen/Qwen2.5-72B-Instruct': 'Qwen/Qwen2.5-72B-Instruct',
  'hf:meta-llama/Llama-3.1-70B-Instruct': 'meta-llama/Llama-3.1-70B-Instruct',
  'hf:mistralai/Mistral-7B-Instruct-v0.3': 'mistralai/Mistral-7B-Instruct-v0.3',
  'hf:google/gemma-2-27b-it': 'google/gemma-2-27b-it',
  'hf:DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking':
    'DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking',
};

const GITHUB_MODELS: Record<string, string> = {
  'gh:gpt-4o': 'gpt-4o',
  'gh:gpt-4o-mini': 'gpt-4o-mini',
  'gh:llama-3.3-70b': 'Meta-Llama-3.3-70B-Instruct',
  'gh:llama-3.1-70b': 'Meta-Llama-3.1-70B-Instruct',
  'gh:mistral-large': 'Mistral-large',
  'gh:phi-4': 'Phi-4',
  'gh:deepseek-v3': 'DeepSeek-V3',
};

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `You are an elite autonomous AI software engineer. You have live, authenticated access to GitHub repos, Supabase databases, Vercel deployments, and a suite of CLI tools. You are NOT a chatbot. You are an agent that DOES THINGS.

## ABSOLUTE RULES

1. **Never ask for clarification** — make the best reasonable assumption and act immediately.
   - "Fix errors in my repo" → scan the repo, find errors, fix them, push commits.
   - "Update the model" → read the config, update it, push.
   - Vague request → pick the most useful interpretation and execute.

2. **Always use tools** — for any task involving code, files, APIs, or data, use tools. Never just describe what you would do.

3. **Read before writing** — always call read_github_file before write_github_file to get the SHA and understand what's there.

4. **Write complete files** — never write partial files or use placeholder comments like "// ... rest of file". Always write the entire file content.

5. **Verify your work** — after writing files, confirm the commit was created. After fixing bugs, explain what was wrong and what you changed.

6. **Be autonomous** — chain multiple tool calls to complete complex tasks. Don't stop after one step and ask what to do next.

## CAPABILITIES

### GitHub (always available when GitHub is connected)
- Explore repos: list_github_directory, read_github_file
- Modify code: write_github_file, delete_github_file  
- History: get_github_commits, get_github_diff
- Search: search_github_code
- Collaboration: create_github_pr, create_github_issue

### Web & Research
- mcp_fetch_url: fetch any URL — docs, live deployments, APIs, raw files

### Memory
- mcp_remember: persist facts across sessions (architecture decisions, URLs, preferences)
- mcp_recall: retrieve stored facts

### Database (when Supabase connected)
- list_supabase_tables, query_supabase, insert_supabase_row, update_supabase_rows, delete_supabase_rows

### Deployment (when Vercel connected)  
- list_vercel_projects, list_vercel_deployments, get_vercel_env_vars, add_vercel_env_var, trigger_vercel_redeploy

### CLI (server-side)
- run_cli: execute gh, rg, fd, git, jq, node, curl, grep, ls, cat, diff
- what_the_diff: explain code changes in plain English

## WORKFLOW PATTERNS

**Fixing bugs in a repo:**
1. list_github_directory → understand structure
2. read_github_file on relevant files → find the bug
3. write_github_file with complete fixed content + SHA
4. Report exactly what was wrong and what changed

**Adding a feature:**
1. read_github_file on files to modify
2. write_github_file with new code
3. create_github_pr with structured description

**Answering "what does X do" about code:**
1. search_github_code to find it
2. read_github_file to see it in context
3. Explain it

**Research + code:**
1. mcp_fetch_url to read relevant docs
2. Apply knowledge to write/fix code

## OUTPUT FORMAT

- Be direct and action-oriented
- Show what you did: "Read route.ts (847 lines) → found bug at line 392 → fixed circular import → pushed commit abc1234"
- When writing code, briefly explain the key changes
- Use code blocks for file paths and code snippets
- Don't pad with filler — every sentence should be useful`;

// ── Gemini caller ─────────────────────────────────────────────────────────────
function buildTools(hasSb: boolean, hasVr: boolean, useSearch: boolean): object[] {
  const tools: object[] = [GITHUB_TOOLS, MCP_TOOLS, CLI_TOOLS];
  if (hasSb) tools.push(SUPABASE_TOOLS);
  if (hasVr) tools.push(VERCEL_TOOLS);
  if (useSearch) tools.push({ google_search: {} });
  return tools;
}

async function callGemini(
  apiKey: string,
  model: string,
  contents: object[],
  hasSb: boolean,
  hasVr: boolean,
  useSearch: boolean,
  systemInst?: string
): Promise<Response> {
  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: systemInst || SYSTEM_INSTRUCTION }] },
    contents,
    tools: buildTools(hasSb, hasVr, useSearch),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── GitHub Models (OpenAI-compatible) with FULL tool loop ────────────────────
const GH_TOOL_DEFS = [
  { type: 'function' as const, function: { name: 'list_github_directory', description: 'List repo directory', parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' } }, required: ['repo'] } } },
  { type: 'function' as const, function: { name: 'read_github_file', description: 'Read file content + SHA', parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } }, required: ['repo', 'path'] } } },
  { type: 'function' as const, function: { name: 'write_github_file', description: 'Create or update a file (requires SHA for updates)', parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' }, sha: { type: 'string' }, branch: { type: 'string' } }, required: ['repo', 'path', 'content', 'message'] } } },
  { type: 'function' as const, function: { name: 'search_github_code', description: 'Search GitHub code', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function' as const, function: { name: 'create_github_pr', description: 'Create a pull request', parameters: { type: 'object', properties: { repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['repo', 'title', 'body', 'head'] } } },
  { type: 'function' as const, function: { name: 'create_github_issue', description: 'Create an issue', parameters: { type: 'object', properties: { repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'string' } }, required: ['repo', 'title', 'body'] } } },
  { type: 'function' as const, function: { name: 'get_github_commits', description: 'Get commit history', parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, count: { type: 'string' } }, required: ['repo'] } } },
  { type: 'function' as const, function: { name: 'mcp_fetch_url', description: 'Fetch a URL', parameters: { type: 'object', properties: { url: { type: 'string' }, max_length: { type: 'string' } }, required: ['url'] } } },
  { type: 'function' as const, function: { name: 'run_shell_command', description: 'Run shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];

async function runGitHubModelsLoop(
  token: string,
  model: string,
  messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
  systemPrompt: string,
  userGhToken: string,
  sbToken: string,
  sbUrl: string,
  vrToken: string,
  maxTurns = 12
): Promise<string> {
  const allMsgs: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[]; name?: string }> = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: allMsgs,
        tools: GH_TOOL_DEFS,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GitHub Models (${res.status}): ${err.slice(0, 300)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (!msg) throw new Error('No message in GitHub Models response');

    // No tool calls — we're done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || 'No response.';
    }

    // Add assistant message with tool calls
    allMsgs.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });

    // Execute all tool calls
    for (const tc of msg.tool_calls) {
      let args: Record<string, string> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }

      const fnName = tc.function.name;
      let result: string;

      const ghFns = ['list_github_directory', 'read_github_file', 'write_github_file', 'delete_github_file',
        'search_github_code', 'create_github_pr', 'create_github_issue', 'get_github_commits', 'get_github_diff', 'run_shell_command'];
      const mcpFns = ['mcp_fetch_url', 'mcp_remember', 'mcp_recall'];
      const sbFns = ['list_supabase_tables', 'query_supabase', 'insert_supabase_row', 'update_supabase_rows', 'delete_supabase_rows'];

      if (ghFns.includes(fnName)) {
        result = await executeGithubFunction(fnName, args, userGhToken);
      } else if (mcpFns.includes(fnName)) {
        result = await executeMcpFunction(fnName, args);
      } else if (sbFns.includes(fnName)) {
        result = await executeSupabaseFunction(fnName, args, sbToken, sbUrl);
      } else {
        result = `Unknown function: ${fnName}`;
      }

      allMsgs.push({ role: 'tool', content: result, tool_call_id: tc.id, name: fnName });
    }
  }

  return 'Max tool-call turns reached.';
}

// ── HuggingFace (single shot — HF Inference API doesn't support tool calls) ──
async function callHuggingFace(
  hfToken: string | null,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(hfToken ? { Authorization: `Bearer ${hfToken}` } : {}),
    },
    body: JSON.stringify({ model: modelId, messages, max_tokens: 4096, temperature: 0.7, stream: false }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HuggingFace (${res.status}): ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? 'No response.';
}

// ── Tool Executors ────────────────────────────────────────────────────────────
async function executeGithubFunction(
  name: string,
  args: Record<string, string>,
  userGhToken?: string
): Promise<string> {
  const token = userGhToken || process.env.GITHUB_TOKEN;
  if (!token && name !== 'run_shell_command') {
    return 'Error: GitHub is not connected. Go to the GitHub tab and connect your account first.';
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AIAgent/1.0',
    'Content-Type': 'application/json',
  };

  try {
    // ── list_github_directory ────────────────────────────────────────────────
    if (name === 'list_github_directory') {
      const { repo, path = '' } = args;
      if (!repo) return 'Error: repo is required (format: owner/repo)';
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, { headers: ghHeaders });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        return `Error listing "${path || '/'}" in ${repo}: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (!Array.isArray(data)) return JSON.stringify(data).slice(0, 1000);
      const items = (data as Array<{ name: string; type: string; size: number; path: string }>)
        .sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name))
        .map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}${f.type === 'file' ? ` (${f.size}B)` : ''}  [${f.path}]`);
      return `📂 ${repo}/${path || ''} — ${items.length} items\n\n${items.join('\n')}`;
    }

    // ── read_github_file ──────────────────────────────────────────────────────
    if (name === 'read_github_file') {
      const { repo, path, ref } = args;
      if (!repo || !path) return 'Error: repo and path are required';
      const url = `https://api.github.com/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
      const res = await fetch(url, { headers: ghHeaders });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        return `Error reading ${path}: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (Array.isArray(data)) return `That path is a directory. Use list_github_directory instead.`;
      if (!data.content) return 'File has no readable content (may be binary or empty)';
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return `📄 ${data.path} | sha: ${data.sha} | ${data.size} bytes\n\`\`\`\n${content}\n\`\`\``;
    }

    // ── write_github_file ─────────────────────────────────────────────────────
    if (name === 'write_github_file') {
      const { repo, path, content, message, sha, branch } = args;
      if (!repo || !path || !content || !message) return 'Error: repo, path, content, message are required';
      const body: Record<string, string> = {
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
      };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        if (res.status === 409 || (err.message || '').includes('sha')) {
          return `Error: SHA mismatch — the file was modified. Call read_github_file first to get the current SHA, then retry.`;
        }
        return `Error writing ${path}: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      return `✅ ${sha ? 'Updated' : 'Created'} \`${path}\` — commit \`${data.commit?.sha?.slice(0, 7)}\` — ${data.content?.html_url || ''}`;
    }

    // ── delete_github_file ────────────────────────────────────────────────────
    if (name === 'delete_github_file') {
      const { repo, path, sha, message, branch } = args;
      if (!repo || !path || !sha || !message) return 'Error: repo, path, sha, message are required';
      const body: Record<string, string> = { message, sha };
      if (branch) body.branch = branch;
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const res = await fetch(url, { method: 'DELETE', headers: ghHeaders, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        return `Error deleting ${path}: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      return `🗑️ Deleted \`${path}\` — commit \`${data.commit?.sha?.slice(0, 7)}\``;
    }

    // ── search_github_code ────────────────────────────────────────────────────
    if (name === 'search_github_code') {
      const { query } = args;
      if (!query) return 'Error: query is required';
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=10`;
      const res = await fetch(url, { headers: { ...ghHeaders, Accept: 'application/vnd.github.v3.text-match+json' } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        return `Search error: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      if (!data.items?.length) return `No code found matching: "${query}"`;
      const results = (data.items as Array<{ path: string; repository: { full_name: string }; html_url: string; text_matches?: Array<{ fragment: string }> }>)
        .slice(0, 8)
        .map(item => {
          const match = item.text_matches?.[0]?.fragment?.slice(0, 150) || '';
          return `📄 ${item.repository.full_name}/${item.path}\n   ${match}`;
        });
      return `Found ${data.total_count} results for "${query}":\n\n${results.join('\n\n')}`;
    }

    // ── create_github_pr ──────────────────────────────────────────────────────
    if (name === 'create_github_pr') {
      const { repo, title, body: prBody, head, base = 'main' } = args;
      if (!repo || !title || !prBody || !head) return 'Error: repo, title, body, head are required';
      const url = `https://api.github.com/repos/${repo}/pulls`;
      const res = await fetch(url, {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({ title, body: prBody, head, base }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string; errors?: Array<{ message: string }> };
        return `Error creating PR: ${err.message || JSON.stringify(err.errors) || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      return `✅ PR created: #${data.number} — "${data.title}"\n${data.html_url}`;
    }

    // ── create_github_issue ───────────────────────────────────────────────────
    if (name === 'create_github_issue') {
      const { repo, title, body: issueBody, labels } = args;
      if (!repo || !title || !issueBody) return 'Error: repo, title, body are required';
      const payload: Record<string, unknown> = { title, body: issueBody };
      if (labels) payload.labels = labels.split(',').map(l => l.trim());
      const url = `https://api.github.com/repos/${repo}/issues`;
      const res = await fetch(url, { method: 'POST', headers: ghHeaders, body: JSON.stringify(payload) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        return `Error creating issue: ${err.message || res.statusText} (${res.status})`;
      }
      const data = await res.json();
      return `✅ Issue created: #${data.number} — "${data.title}"\n${data.html_url}`;
    }

    // ── get_github_commits ────────────────────────────────────────────────────
    if (name === 'get_github_commits') {
      const { repo, path: filePath, count = '10' } = args;
      if (!repo) return 'Error: repo is required';
      let url = `https://api.github.com/repos/${repo}/commits?per_page=${count}`;
      if (filePath) url += `&path=${encodeURIComponent(filePath)}`;
      const res = await fetch(url, { headers: ghHeaders });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        return `Error fetching commits: ${err.message || res.statusText}`;
      }
      const commits = await res.json();
      if (!Array.isArray(commits) || commits.length === 0) return 'No commits found.';
      const lines = (commits as Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>)
        .map(c => `\`${c.sha.slice(0, 7)}\` ${c.commit.message.split('\n')[0].slice(0, 80)} — ${c.commit.author.name} (${c.commit.author.date.slice(0, 10)})`);
      return `Last ${lines.length} commits${filePath ? ` for ${filePath}` : ''}:\n\n${lines.join('\n')}`;
    }

    // ── get_github_diff ───────────────────────────────────────────────────────
    if (name === 'get_github_diff') {
      const { repo, sha, base, head } = args;
      if (!repo) return 'Error: repo is required';
      let url: string;
      if (sha) {
        url = `https://api.github.com/repos/${repo}/commits/${sha}`;
      } else if (base && head) {
        url = `https://api.github.com/repos/${repo}/compare/${base}...${head}`;
      } else {
        return 'Error: provide sha or both base+head';
      }
      const res = await fetch(url, { headers: { ...ghHeaders, Accept: 'application/vnd.github.v3.diff' } });
      if (!res.ok) return `Error fetching diff: ${res.statusText} (${res.status})`;
      const diff = await res.text();
      return diff.slice(0, 8000) || '(empty diff)';
    }

    // ── run_shell_command ─────────────────────────────────────────────────────
    if (name === 'run_shell_command') {
      const { command } = args;
      if (!command) return 'Error: command is required';
      const blocked = ['rm -rf /', 'sudo rm', 'mkfs', ':(){', '> /dev/sda'];
      for (const b of blocked) {
        if (command.includes(b)) return `Blocked: "${b}" not permitted`;
      }
      try {
        const { stdout, stderr } = await execAsync(command, { timeout: 15000, cwd: '/tmp' });
        return (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim() || '(no output)';
      } catch (e: unknown) {
        const ex = e as { stdout?: string; stderr?: string; message?: string };
        return ex.stdout || ex.stderr || ex.message || 'Command failed';
      }
    }

    return `Unknown GitHub function: ${name}`;
  } catch (e) {
    return `Error in ${name}: ${e instanceof Error ? e.message : 'Unknown error'}`;
  }
}

async function executeMcpFunction(name: string, args: Record<string, string>): Promise<string> {
  try {
    if (name === 'mcp_fetch_url') {
      const { url, max_length = '8000' } = args;
      if (!url) return 'Error: url is required';
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIAgent/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `Fetch failed: HTTP ${res.status} for ${url}`;
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, parseInt(max_length));
      return text || '(empty page)';
    }
    if (name === 'mcp_remember') {
      const { key, value } = args;
      if (!key || value === undefined) return 'Error: key and value are required';
      _agentMemory[key] = value;
      return `✅ Remembered: ${key} = ${value.slice(0, 100)}`;
    }
    if (name === 'mcp_recall') {
      const { key } = args;
      if (!key) return 'Error: key is required';
      return _agentMemory[key] !== undefined ? `${key}: ${_agentMemory[key]}` : `No value stored for key: ${key}`;
    }
    return `Unknown MCP function: ${name}`;
  } catch (e) {
    return `MCP error (${name}): ${e instanceof Error ? e.message : 'Unknown'}`;
  }
}

async function executeSupabaseFunction(
  name: string,
  args: Record<string, string>,
  sbToken: string,
  sbUrl: string
): Promise<string> {
  if (!sbToken || !sbUrl) return 'Supabase not connected. Add your Supabase URL and access token in Integrations.';
  const headers = {
    apikey: sbToken,
    Authorization: `Bearer ${sbToken}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const base = `${sbUrl}/rest/v1`;

  try {
    if (name === 'list_supabase_tables') {
      const res = await fetch(`${sbUrl}/rest/v1/?apikey=${sbToken}`);
      if (!res.ok) return `Supabase error: ${res.statusText}`;
      const data = await res.json();
      const tables = Object.keys(data?.definitions || data?.paths || {}).filter(k => !k.startsWith('/')).slice(0, 30);
      if (tables.length) return `Tables (${tables.length}): ${tables.join(', ')}`;
      // Fallback: try information_schema
      const res2 = await fetch(`${base}/information_schema_tables?select=table_name&table_schema=eq.public`, { headers });
      if (res2.ok) {
        const rows = await res2.json();
        return `Tables: ${rows.map((r: { table_name: string }) => r.table_name).join(', ')}`;
      }
      return 'Could not list tables. Ensure your Supabase token has read access.';
    }

    if (name === 'query_supabase') {
      const { table, select = '*', filter, limit = '50' } = args;
      if (!table) return 'Error: table is required';
      let url = `${base}/${table}?select=${select}&limit=${limit}`;
      if (filter) {
        try {
          const f = JSON.parse(filter);
          Object.entries(f).forEach(([k, v]) => { url += `&${k}=eq.${v}`; });
        } catch { return 'Error: filter must be valid JSON'; }
      }
      const res = await fetch(url, { headers });
      if (!res.ok) return `Query error: ${res.statusText} (${res.status})`;
      const data = await res.json();
      return `${Array.isArray(data) ? data.length : 0} rows:\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 3000)}\n\`\`\``;
    }

    if (name === 'insert_supabase_row') {
      const { table, data } = args;
      if (!table || !data) return 'Error: table and data are required';
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return 'Error: data must be valid JSON'; }
      const res = await fetch(`${base}/${table}`, { method: 'POST', headers, body: JSON.stringify(parsed) });
      if (!res.ok) return `Insert error: ${await res.text()}`;
      const result = await res.json();
      return `✅ Inserted: ${JSON.stringify(result).slice(0, 500)}`;
    }

    if (name === 'update_supabase_rows') {
      const { table, filter, data } = args;
      if (!table || !filter || !data) return 'Error: table, filter, data are required';
      let url = `${base}/${table}?`;
      try {
        const f = JSON.parse(filter);
        Object.entries(f).forEach(([k, v]) => { url += `&${k}=eq.${v}`; });
      } catch { return 'Error: filter must be valid JSON'; }
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return 'Error: data must be valid JSON'; }
      const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(parsed) });
      if (!res.ok) return `Update error: ${await res.text()}`;
      const result = await res.json();
      return `✅ Updated ${Array.isArray(result) ? result.length : '?'} rows`;
    }

    if (name === 'delete_supabase_rows') {
      const { table, filter } = args;
      if (!table || !filter) return 'Error: table and filter are required';
      let url = `${base}/${table}?`;
      try {
        const f = JSON.parse(filter);
        Object.entries(f).forEach(([k, v]) => { url += `&${k}=eq.${v}`; });
      } catch { return 'Error: filter must be valid JSON'; }
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok) return `Delete error: ${await res.text()}`;
      return `✅ Deleted rows matching filter`;
    }

    return `Unknown Supabase function: ${name}`;
  } catch (e) {
    return `Supabase error (${name}): ${e instanceof Error ? e.message : 'Unknown'}`;
  }
}

async function executeVercelFunction(
  name: string,
  args: Record<string, string>,
  vrToken: string
): Promise<string> {
  if (!vrToken) return 'Vercel not connected. Add your Vercel token in Integrations.';
  const headers = { Authorization: `Bearer ${vrToken}`, 'Content-Type': 'application/json' };

  try {
    if (name === 'list_vercel_projects') {
      const res = await fetch('https://api.vercel.com/v9/projects?limit=20', { headers });
      if (!res.ok) return `Vercel error: ${res.statusText}`;
      const data = await res.json();
      const projects = (data.projects || []) as Array<{ id: string; name: string; framework: string; updatedAt: number }>;
      return projects.map(p => `${p.name} (${p.id}) — ${p.framework || 'unknown'}`).join('\n') || 'No projects found.';
    }

    if (name === 'list_vercel_deployments') {
      const { projectId, limit = '5' } = args;
      if (!projectId) return 'Error: projectId is required';
      const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=${limit}`, { headers });
      if (!res.ok) return `Vercel error: ${res.statusText}`;
      const data = await res.json();
      const deps = (data.deployments || []) as Array<{ uid: string; url: string; state: string; createdAt: number; meta?: { githubCommitMessage?: string } }>;
      return deps.map(d =>
        `${d.state} | ${d.url} | ${new Date(d.createdAt).toISOString().slice(0, 16)} | ${d.meta?.githubCommitMessage?.slice(0, 60) || ''}`
      ).join('\n') || 'No deployments.';
    }

    if (name === 'get_vercel_env_vars') {
      const { projectId } = args;
      if (!projectId) return 'Error: projectId is required';
      const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, { headers });
      if (!res.ok) return `Vercel error: ${res.statusText}`;
      const data = await res.json();
      const envs = (data.envs || []) as Array<{ key: string; target: string[]; type: string }>;
      return envs.map(e => `${e.key} [${e.target.join(',')}] (${e.type})`).join('\n') || 'No env vars.';
    }

    if (name === 'add_vercel_env_var') {
      const { projectId, key, value, target = 'production,preview' } = args;
      if (!projectId || !key || !value) return 'Error: projectId, key, value are required';
      const targets = target.split(',').map(t => t.trim());
      const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ key, value, target: targets, type: 'plain' }),
      });
      if (!res.ok) return `Vercel error: ${await res.text()}`;
      return `✅ Added env var: ${key} → [${targets.join(',')}]`;
    }

    if (name === 'trigger_vercel_redeploy') {
      const { projectId, deploymentId } = args;
      if (!projectId) return 'Error: projectId is required';
      if (deploymentId) {
        const res = await fetch(`https://api.vercel.com/v13/deployments?forceNew=1`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ deploymentId }),
        });
        if (!res.ok) return `Redeploy error: ${await res.text()}`;
        const data = await res.json();
        return `✅ Redeploying: ${data.url || deploymentId}`;
      }
      return 'Provide deploymentId to redeploy a specific deployment.';
    }

    return `Unknown Vercel function: ${name}`;
  } catch (e) {
    return `Vercel error (${name}): ${e instanceof Error ? e.message : 'Unknown'}`;
  }
}

async function executeCliFunction(
  name: string,
  args: Record<string, string>,
  userGhToken?: string
): Promise<string> {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const ghToken = userGhToken || process.env.GITHUB_TOKEN || '';

  if (name === 'what_the_diff') {
    const { diff_text } = args;
    if (!diff_text) return 'Error: diff_text is required';
    const diffLines = diff_text.split('\n');
    const added = diffLines.filter(l => l.startsWith('+')).length;
    const removed = diffLines.filter(l => l.startsWith('-')).length;
    const files = [...new Set(diffLines.filter(l => l.startsWith('+++') || l.startsWith('---'))
      .map(l => l.replace(/^[+-]{3} [ab]?\//, '')))].filter(f => f !== '/dev/null');
    return `Diff: ${files.join(', ')} | +${added} lines, -${removed} lines\n\n${diff_text.slice(0, 4000)}`;
  }

  if (name === 'run_cli') {
    const { tool, args: argsStr, timeout = '20000' } = args;
    if (!tool) return 'Error: tool is required';
    let parsedArgs: string[] = [];
    try { parsedArgs = JSON.parse(argsStr || '[]'); } catch {
      parsedArgs = (argsStr || '').split(' ').filter(Boolean);
    }
    try {
      const res = await fetch(`${baseUrl}/api/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args: parsedArgs, timeout: parseInt(timeout), github_token: ghToken }),
      });
      const data = await res.json();
      if (data.available === false) return `${tool} not installed. ${data.hint || ''}`;
      if (!res.ok && !data.output) return `CLI error: ${data.error || res.statusText}`;
      return data.output || data.stdout || '(no output)';
    } catch (e) {
      return `CLI call failed: ${e instanceof Error ? e.message : 'Unknown'}`;
    }
  }

  return `Unknown CLI function: ${name}`;
}

// ── Auto key/token detection ──────────────────────────────────────────────────
const KEY_PATTERNS: { pattern: RegExp; field: string; label: string }[] = [
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/, field: 'github_token', label: 'GitHub personal access token' },
  { pattern: /\bghs_[A-Za-z0-9]{36,}\b/, field: 'github_token', label: 'GitHub token' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}\b/, field: 'github_token', label: 'GitHub fine-grained token' },
  { pattern: /\bvercel_[A-Za-z0-9]{20,}\b/i, field: 'vercel_access_token', label: 'Vercel token' },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/, field: 'hf_api_key', label: 'HuggingFace token' },
  { pattern: /\bAIza[A-Za-z0-9\-_]{35,}\b/, field: 'custom_gemini_api_key', label: 'Gemini API key' },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/, field: 'openai_api_key', label: 'OpenAI key' },
];

// ── POST /api/chat ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { message, history, settings, session_id: sessionId } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }

    // ── Auto-detect pasted tokens/keys ───────────────────────────────────────
    let detectedKey: { field: string; value: string; label: string } | null = null;
    for (const { pattern, field, label } of KEY_PATTERNS) {
      const match = message.match(pattern);
      if (match) { detectedKey = { field, value: match[0], label }; break; }
    }
    const sbUrlMatch = message.match(/https:\/\/[a-z]{20}\.supabase\.co/);

    if (detectedKey || sbUrlMatch) {
      const parts: string[] = [];
      if (detectedKey) parts.push(`${detectedKey.label} saved ✓`);
      if (sbUrlMatch) parts.push('Supabase URL saved ✓');
      // Return confirmation — the frontend will persist via saveSettings
      return NextResponse.json({
        text: `Got it — ${parts.join(', ')}. Saved and ready. You can now use that integration in your requests.`,
        detected_keys: [
          ...(detectedKey ? [{ field: detectedKey.field, value: detectedKey.value }] : []),
          ...(sbUrlMatch ? [{ field: 'supabase_url', value: sbUrlMatch[0] }] : []),
        ],
      });
    }

    // ── Extract settings ──────────────────────────────────────────────────────
    const apiKey = settings?.is_custom_gemini_key_enabled && settings?.custom_gemini_api_key
      ? settings.custom_gemini_api_key
      : process.env.GEMINI_API_KEY;
    const useSearch = !!settings?.enable_web_search;
    const sbToken: string = settings?.supabase_access_token || '';
    const sbUrl: string = settings?.supabase_url || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const vrToken: string = settings?.vercel_access_token || '';
    const userGhToken: string = settings?.github_token || '';
    const hasSb = !!(sbToken && sbUrl);
    const hasVr = !!vrToken;
    const requested: string = settings?.active_model_name || 'gemini-2.5-flash';

    // Build system context with connected account info
    let systemWithContext = SYSTEM_INSTRUCTION;
    if (userGhToken && settings?.github_username) {
      systemWithContext += `\n\n## CONNECTED GITHUB ACCOUNT\nUsername: ${settings.github_username}\nWhen the user says "my repo" or doesn\'t specify owner, use ${settings.github_username} as the owner.`;
    }
    if (hasSb) systemWithContext += `\n\n## CONNECTED SUPABASE\nURL: ${sbUrl}`;
    if (hasVr) systemWithContext += `\n\n## CONNECTED VERCEL\nToken available — can list/deploy projects.`;

    // Build history as Gemini contents
    const baseContents: object[] = [
      ...(history || []).map((h: { role: string; text: string }) => ({
        role: h.role === 'assistant' ? 'model' : h.role,
        parts: [{ text: h.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    // ── HuggingFace (single-shot, no tool loop) ───────────────────────────────
    if (requested.startsWith('hf:')) {
      const hfModelId = HF_MODELS[requested] ?? requested.slice(3);
      const hfToken = settings?.hf_api_key || process.env.HF_TOKEN || null;
      const hfMsgs = [
        { role: 'system', content: systemWithContext },
        ...(history || []).map((h: { role: string; text: string }) => ({
          role: h.role === 'model' ? 'assistant' : h.role,
          content: h.text,
        })),
        { role: 'user', content: message },
      ];
      try {
        const answer = await callHuggingFace(hfToken, hfModelId, hfMsgs);
        return NextResponse.json({ text: answer, model: hfModelId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'HuggingFace error';
        const hint = msg.includes('401') || msg.includes('403')
          ? 'HuggingFace token required. Get a free token at huggingface.co/settings/tokens and paste it in Model Settings.'
          : msg;
        return NextResponse.json({ error: hint }, { status: 500 });
      }
    }

    // ── GitHub Models — full agentic tool loop ────────────────────────────────
    if (requested.startsWith('gh:')) {
      const ghModelId = GITHUB_MODELS[requested] ?? requested.slice(3);
      const ghToken = userGhToken || process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '';
      if (!ghToken) {
        return NextResponse.json({
          error: 'Connect GitHub in the GitHub tab to use GitHub Models (GPT-4o etc.) for free — no extra API key needed.',
        }, { status: 401 });
      }
      const ghMsgs = (history || []).map((h: { role: string; text: string }) => ({
        role: h.role === 'model' ? 'assistant' : h.role,
        content: h.text,
      }));
      ghMsgs.push({ role: 'user', content: message });

      try {
        const answer = await runGitHubModelsLoop(
          ghToken, ghModelId, ghMsgs, systemWithContext,
          userGhToken, sbToken, sbUrl, vrToken
        );
        return NextResponse.json({ text: answer, model: ghModelId });
      } catch (e) {
        return NextResponse.json({
          error: e instanceof Error ? e.message : 'GitHub Models error',
        }, { status: 500 });
      }
    }

    // ── Gemini with agentic tool loop ─────────────────────────────────────────
    if (!apiKey) {
      return NextResponse.json({
        error: 'No Gemini API key. Switch to a GitHub Model in Model Settings (free via GitHub OAuth) or add a Gemini key.',
      }, { status: 401 });
    }

    const modelsToTry = [requested, ...FALLBACK_MODELS.filter(m => m !== requested)];
    let geminiRes: Response | null = null;
    let usedModel = requested;

    for (const model of modelsToTry) {
      const res = await callGemini(apiKey, model, baseContents, hasSb, hasVr, useSearch, systemWithContext);
      if (res.ok) { geminiRes = res; usedModel = model; break; }
      const errText = await res.text();
      let errCode: number | undefined;
      try { errCode = JSON.parse(errText)?.error?.code; } catch { /* ignore */ }
      // Stop immediately on auth/invalid errors — don't try fallbacks
      if (errCode !== 503 && errCode !== 429 && errCode !== 404) {
        let friendlyErr = errText;
        try {
          const parsed = JSON.parse(errText);
          const msg = parsed?.error?.message || parsed?.message || '';
          if (msg) friendlyErr = `Gemini: ${msg}`;
        } catch { /* use raw */ }
        return NextResponse.json({ error: friendlyErr }, { status: 500 });
      }
    }

    // Gemini quota exhausted — fallback to GitHub Models if available
    if (!geminiRes) {
      const ghFallback = userGhToken || process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '';
      if (ghFallback) {
        const ghMsgs = (history || []).map((h: { role: string; text: string }) => ({
          role: h.role === 'model' ? 'assistant' : h.role,
          content: h.text,
        }));
        ghMsgs.push({ role: 'user', content: message });
        try {
          const answer = await runGitHubModelsLoop(
            ghFallback, 'gpt-4o', ghMsgs, systemWithContext,
            userGhToken, sbToken, sbUrl, vrToken
          );
          return NextResponse.json({ text: answer, model: 'gpt-4o (auto-fallback)' });
        } catch { /* fall through */ }
      }
      return NextResponse.json({
        error: 'Gemini quota reached (5 req/min free tier). Connect GitHub to use GPT-4o for free via GitHub Models.',
      }, { status: 429 });
    }

    // ── Gemini agentic loop ───────────────────────────────────────────────────
    const sbFnNames = ['list_supabase_tables', 'query_supabase', 'insert_supabase_row', 'update_supabase_rows', 'delete_supabase_rows'];
    const vrFnNames = ['list_vercel_projects', 'list_vercel_deployments', 'get_vercel_env_vars', 'add_vercel_env_var', 'trigger_vercel_redeploy'];
    const mcpFnNames = ['mcp_fetch_url', 'mcp_remember', 'mcp_recall'];
    const cliFnNames = ['run_cli', 'what_the_diff'];

    let currentContents: object[] = [...baseContents];
    let currentRes = geminiRes;
    const MAX_TURNS = 15;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const geminiData = await currentRes.json();

      if (geminiData.error) {
        return NextResponse.json({ error: geminiData.error.message || 'Gemini error' }, { status: 500 });
      }

      const candidate = geminiData.candidates?.[0];
      const parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, string> } }> =
        candidate?.content?.parts || [];

      const fnCalls = parts.filter(p => p.functionCall);

      // No tool calls — terminal turn
      if (fnCalls.length === 0) {
        const textParts = parts.filter(p => p.text).map(p => p.text!);
        let text = textParts.join('\n').trim() || 'Done.';

        if (usedModel !== requested) {
          text += `\n\n_(switched to ${usedModel} — ${requested} was unavailable)_`;
        }

        // Grounding sources
        const groundingMeta = candidate?.groundingMetadata;
        if (groundingMeta?.groundingChunks?.length) {
          const sources = (groundingMeta.groundingChunks as Array<{ web?: { uri: string; title: string } }>)
            .slice(0, 5)
            .map(c => c.web ? `[${c.web.title || c.web.uri}](${c.web.uri})` : null)
            .filter(Boolean)
            .join(' · ');
          if (sources) text += `\n\n🔍 Sources: ${sources}`;
        }

        return NextResponse.json({ text });
      }

      // Execute all tool calls in parallel
      const fnResults = await Promise.all(
        fnCalls.map(async (p) => {
          const fn = p.functionCall!;
          let result: string;

          if (sbFnNames.includes(fn.name)) {
            result = await executeSupabaseFunction(fn.name, fn.args || {}, sbToken, sbUrl);
          } else if (vrFnNames.includes(fn.name)) {
            result = await executeVercelFunction(fn.name, fn.args || {}, vrToken);
          } else if (mcpFnNames.includes(fn.name)) {
            result = await executeMcpFunction(fn.name, fn.args || {});
          } else if (cliFnNames.includes(fn.name)) {
            result = await executeCliFunction(fn.name, fn.args || {}, userGhToken);
          } else {
            result = await executeGithubFunction(fn.name, fn.args || {}, userGhToken);
          }

          return { functionResponse: { name: fn.name, response: { result } } };
        })
      );

      // Continue conversation
      currentContents = [
        ...currentContents,
        { role: 'model', parts },
        { role: 'user', parts: fnResults },
      ];

      currentRes = await callGemini(apiKey, usedModel, currentContents, hasSb, hasVr, useSearch, systemWithContext);
      if (!currentRes.ok) {
        const err = await currentRes.text();
        return NextResponse.json({ error: `Gemini error on turn ${turn + 1}: ${err.slice(0, 200)}` }, { status: 500 });
      }
    }

    return NextResponse.json({ error: 'Max tool-call turns reached. The task may require breaking it into smaller steps.' }, { status: 500 });

  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Internal server error' }, { status: 500 });
  }
}
