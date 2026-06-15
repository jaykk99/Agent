/**
 * web/app/api/chat/route.ts
 *
 * Autonomous Agent — State-Graph Orchestration
 * ─────────────────────────────────────────────
 * Architecture:
 *   • Cyclic state-machine with self-correcting loop (max 15 turns)
 *   • Server-side tool execution — no client-side credential exposure
 *   • Dynamic tool filtering based on request context (saves ~80% tokens)
 *   • Runtime schema validation on every tool call before execution
 *   • Circuit breaker: MAX_TURNS + 200k token budget cap
 *   • Self-correction: forces summary turn when model returns empty text
 *   • Multi-provider: Gemini (primary) → GitHub Models (fallback) → HF
 *   • Rate limiting (20 req/60s per IP)
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { rateLimit } from '@/lib/rateLimit';

const execAsync = promisify(exec);

// ── Circuit breaker constants ─────────────────────────────────────────────────
const MAX_TURNS       = 15;
const MAX_COST_TOKENS = 200_000;
const TOOL_TIMEOUT_MS = 20_000;
const SUMMARY_PROMPT  = 'Summarise EVERYTHING you found and did: every file read, every bug found, every change made, every commit pushed. Be specific. Never say just "Done."';

// ── In-process memory ─────────────────────────────────────────────────────────
const _agentMemory: Record<string, string> = {};
let _estimatedTokens = 0;

// ── Tool Schema Registry (runtime validation) ─────────────────────────────────
interface ToolSchema {
  name: string;
  description: string;
  params: Record<string, { type: string }>;
  required: string[];
  category: 'github' | 'mcp' | 'supabase' | 'vercel' | 'cli';
}

const TOOL_REGISTRY: ToolSchema[] = [
  // GitHub
  { name: 'list_github_directory', description: 'List files/folders in a GitHub repo directory. Call first to explore structure.', params: { repo:{type:'string'}, path:{type:'string'} }, required: ['repo'], category: 'github' },
  { name: 'read_github_file',      description: 'Read full file content + SHA. ALWAYS call this before write_github_file to get the SHA.', params: { repo:{type:'string'}, path:{type:'string'}, ref:{type:'string'} }, required: ['repo','path'], category: 'github' },
  { name: 'write_github_file',     description: 'Create or update a file. Requires sha for updates (from read_github_file). Write COMPLETE content — never truncate.', params: { repo:{type:'string'}, path:{type:'string'}, content:{type:'string'}, message:{type:'string'}, sha:{type:'string'}, branch:{type:'string'} }, required: ['repo','path','content','message'], category: 'github' },
  { name: 'delete_github_file',    description: 'Delete a file. Requires sha from read_github_file.', params: { repo:{type:'string'}, path:{type:'string'}, sha:{type:'string'}, message:{type:'string'}, branch:{type:'string'} }, required: ['repo','path','sha','message'], category: 'github' },
  { name: 'search_github_code',    description: 'Search code across GitHub using GitHub Code Search.', params: { query:{type:'string'} }, required: ['query'], category: 'github' },
  { name: 'create_github_pr',      description: 'Create a Pull Request after pushing to a branch.', params: { repo:{type:'string'}, title:{type:'string'}, body:{type:'string'}, head:{type:'string'}, base:{type:'string'} }, required: ['repo','title','body','head'], category: 'github' },
  { name: 'create_github_issue',   description: 'Create a GitHub issue.', params: { repo:{type:'string'}, title:{type:'string'}, body:{type:'string'}, labels:{type:'string'} }, required: ['repo','title','body'], category: 'github' },
  { name: 'get_github_commits',    description: 'Get commit history for a repo or file.', params: { repo:{type:'string'}, path:{type:'string'}, count:{type:'string'} }, required: ['repo'], category: 'github' },
  { name: 'get_github_diff',       description: 'Get diff of a commit or compare two refs.', params: { repo:{type:'string'}, sha:{type:'string'}, base:{type:'string'}, head:{type:'string'} }, required: ['repo'], category: 'github' },
  { name: 'run_shell_command',     description: 'Run a shell command server-side for quick operations.', params: { command:{type:'string'} }, required: ['command'], category: 'cli' },
  // MCP
  { name: 'mcp_fetch_url',  description: 'Fetch any URL and return readable text. Use for live docs, API checks, raw files.', params: { url:{type:'string'}, max_length:{type:'string'} }, required: ['url'], category: 'mcp' },
  { name: 'mcp_remember',   description: 'Persist a key/value fact for this conversation.', params: { key:{type:'string'}, value:{type:'string'} }, required: ['key','value'], category: 'mcp' },
  { name: 'mcp_recall',     description: 'Retrieve a stored fact by key.', params: { key:{type:'string'} }, required: ['key'], category: 'mcp' },
  // Supabase
  { name: 'list_supabase_tables',  description: 'List all tables in Supabase.', params: {}, required: [], category: 'supabase' },
  { name: 'query_supabase',        description: 'SELECT from a Supabase table.', params: { table:{type:'string'}, select:{type:'string'}, filter:{type:'string'}, limit:{type:'string'} }, required: ['table'], category: 'supabase' },
  { name: 'insert_supabase_row',   description: 'INSERT a row.', params: { table:{type:'string'}, data:{type:'string'} }, required: ['table','data'], category: 'supabase' },
  { name: 'update_supabase_rows',  description: 'UPDATE rows matching filter.', params: { table:{type:'string'}, filter:{type:'string'}, data:{type:'string'} }, required: ['table','filter','data'], category: 'supabase' },
  { name: 'delete_supabase_rows',  description: 'DELETE rows matching filter.', params: { table:{type:'string'}, filter:{type:'string'} }, required: ['table','filter'], category: 'supabase' },
  // Vercel
  { name: 'list_vercel_projects',    description: 'List Vercel projects.', params: {}, required: [], category: 'vercel' },
  { name: 'list_vercel_deployments', description: 'List deployments for a project.', params: { projectId:{type:'string'}, limit:{type:'string'} }, required: ['projectId'], category: 'vercel' },
  { name: 'get_vercel_env_vars',     description: 'Get env vars for a project.', params: { projectId:{type:'string'} }, required: ['projectId'], category: 'vercel' },
  { name: 'add_vercel_env_var',      description: 'Add/update an env var.', params: { projectId:{type:'string'}, key:{type:'string'}, value:{type:'string'}, target:{type:'string'} }, required: ['projectId','key','value'], category: 'vercel' },
  { name: 'trigger_vercel_redeploy', description: 'Trigger a redeployment.', params: { projectId:{type:'string'}, deploymentId:{type:'string'} }, required: ['projectId'], category: 'vercel' },
];

// ── Runtime schema validation ──────────────────────────────────────────────────
function validateToolArgs(name: string, args: Record<string, string>): { ok: boolean; error?: string } {
  const schema = TOOL_REGISTRY.find(s => s.name === name);
  if (!schema) return { ok: false, error: `Unknown tool: ${name}. Available: ${TOOL_REGISTRY.map(s=>s.name).join(', ')}` };
  for (const req of schema.required) {
    if (!args[req] || args[req].trim() === '') {
      return { ok: false, error: `Tool '${name}' requires '${req}' but it was empty. Check the tool description and retry with all required params.` };
    }
  }
  return { ok: true };
}

// ── Dynamic tool filtering (token conservation — reduces context by ~80%) ─────
function selectActiveTools(message: string, hasGh: boolean, hasSb: boolean, hasVr: boolean): ToolSchema[] {
  const m = message.toLowerCase();
  const needsGh  = hasGh && (m.includes('repo')||m.includes('github')||m.includes('file')||m.includes('code')||m.includes('commit')||m.includes('pr')||m.includes('fix')||m.includes('bug')||m.includes('push')||m.includes('read')||m.includes('write')||m.includes('audit')||m.includes('error')||m.includes('deploy'));
  const needsSb  = hasSb && (m.includes('supabase')||m.includes('database')||m.includes('table')||m.includes('query')||m.includes(' db '));
  const needsVr  = hasVr && (m.includes('vercel')||m.includes('deploy')||m.includes('env var')||m.includes('environment'));
  const needsFetch = m.includes('http')||m.includes('url')||m.includes('fetch')||m.includes('website')||m.includes('docs')||m.includes('check if');

  return TOOL_REGISTRY.filter(s => {
    if (s.category === 'cli')      return true;
    if (s.category === 'mcp')     return s.name==='mcp_fetch_url' ? (needsFetch||needsGh) : true;
    if (s.category === 'github')  return needsGh || (!hasSb && !hasVr); // always include when no other integrations
    if (s.category === 'supabase') return needsSb;
    if (s.category === 'vercel')  return needsVr;
    return true;
  });
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an elite autonomous AI software engineer. You have live authenticated access to GitHub repos, Supabase, Vercel, and CLI tools. You execute tasks — you are NOT a chatbot.

## NON-NEGOTIABLE RULES

0. NEVER respond with just "Done." or a single word. Always give a full detailed report.
1. Never ask for clarification — make the best assumption and act immediately.
2. Always use tools — never just describe what you would do.
3. Read before writing — call read_github_file before write_github_file (you need the SHA).
4. Write COMPLETE files — never use "// ... rest of file" or partial content.
5. Chain autonomously — after each tool result, immediately decide the next step.
6. Self-correct — if a tool returns an error, diagnose it and retry with fixed parameters.
7. Report everything — list every file read, every bug found, every commit pushed.

## PATTERNS

Audit a repo: list_github_directory → read key files → write fixes → report
Add a feature: read relevant files → write complete new version → report what changed
Research: mcp_fetch_url for docs → apply knowledge to code

## OUTPUT
- Full report after every task: files read, bugs found, changes made, commits pushed
- Code blocks for file paths and snippets
- Show commit SHAs when you push code`;

// ── Build Gemini tool declarations ────────────────────────────────────────────
function buildGeminiTools(schemas: ToolSchema[], useSearch: boolean): object[] {
  const tools: object[] = [{
    functionDeclarations: schemas.map(s => ({
      name: s.name,
      description: s.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(s.params).map(([k,v])=>[k,{type:v.type}])),
        required: s.required,
      },
    })),
  }];
  if (useSearch) tools.push({ google_search: {} });
  return tools;
}

// ── Build OpenAI-compatible tool declarations ─────────────────────────────────
function buildOAITools(schemas: ToolSchema[]) {
  return schemas.map(s => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(s.params).map(([k,v])=>[k,{type:v.type}])),
        required: s.required,
      },
    },
  }));
}

// ── Model configs ─────────────────────────────────────────────────────────────
const GEMINI_FALLBACKS = ['gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite','gemini-2.0-flash'];
const HF_MODELS: Record<string,string> = {
  'hf:Qwen/Qwen2.5-72B-Instruct':'Qwen/Qwen2.5-72B-Instruct',
  'hf:meta-llama/Llama-3.1-70B-Instruct':'meta-llama/Llama-3.1-70B-Instruct',
  'hf:mistralai/Mistral-7B-Instruct-v0.3':'mistralai/Mistral-7B-Instruct-v0.3',
  'hf:google/gemma-2-27b-it':'google/gemma-2-27b-it',
  'hf:DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking':'DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking',
};
const GITHUB_MODELS: Record<string,string> = {
  'gh:gpt-4o':'gpt-4o','gh:gpt-4o-mini':'gpt-4o-mini',
  'gh:llama-3.3-70b':'Meta-Llama-3.3-70B-Instruct','gh:llama-3.1-70b':'Meta-Llama-3.1-70B-Instruct',
  'gh:mistral-large':'Mistral-large','gh:phi-4':'Phi-4','gh:deepseek-v3':'DeepSeek-V3',
};

// ── Key auto-detect patterns ───────────────────────────────────────────────────
const KEY_PATTERNS = [
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/, field: 'github_token', label: 'GitHub PAT' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}\b/, field: 'github_token', label: 'GitHub fine-grained token' },
  { pattern: /\bvercel_[A-Za-z0-9]{20,}\b/i, field: 'vercel_access_token', label: 'Vercel token' },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/, field: 'hf_api_key', label: 'HuggingFace token' },
  { pattern: /\bAIza[A-Za-z0-9\-_]{35,}\b/, field: 'custom_gemini_api_key', label: 'Gemini API key' },
];

// ── Gemini API caller ─────────────────────────────────────────────────────────
async function callGemini(apiKey: string, model: string, contents: object[], tools: object[], system: string): Promise<Response> {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        tools,
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
}

// ── HuggingFace single-shot ───────────────────────────────────────────────────
async function callHuggingFace(token: string|null, modelId: string, msgs: Array<{role:string;content:string}>): Promise<string> {
  const res = await fetch(`https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) },
    body: JSON.stringify({ model: modelId, messages: msgs, max_tokens: 4096, temperature: 0.7, stream: false }),
  });
  if (!res.ok) throw new Error(`HuggingFace ${res.status}: ${(await res.text()).slice(0,200)}`);
  const d = await res.json();
  return d?.choices?.[0]?.message?.content ?? 'No response.';
}

// ── GitHub Models agentic loop ────────────────────────────────────────────────
async function runGitHubModelsLoop(
  token: string, model: string,
  messages: Array<{role:string;content:string|null;tool_calls?:unknown[];tool_call_id?:string;name?:string}>,
  system: string, schemas: ToolSchema[],
  ghToken: string, sbToken: string, sbUrl: string, vrToken: string
): Promise<string> {
  const msgs: typeof messages = [{ role:'system', content:system }, ...messages];
  const tools = buildOAITools(schemas);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model, messages:msgs, tools, tool_choice:'auto', temperature:0.7, max_tokens:4096 }),
    });
    if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('No message from GitHub Models');

    if (!msg.tool_calls?.length) {
      if ((!msg.content||!msg.content.trim()) && turn > 0) {
        msgs.push({ role:'assistant', content:null });
        msgs.push({ role:'user', content:SUMMARY_PROMPT });
        continue;
      }
      return msg.content || 'Task completed.';
    }

    msgs.push({ role:'assistant', content:msg.content||null, tool_calls:msg.tool_calls });

    for (const tc of msg.tool_calls) {
      let args: Record<string,string> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
      const val = validateToolArgs(tc.function.name, args);
      const result = val.ok
        ? await dispatchTool(tc.function.name, args, ghToken, sbToken, sbUrl, vrToken)
        : `Validation error: ${val.error}`;
      msgs.push({ role:'tool', content:result, tool_call_id:tc.id, name:tc.function.name });
    }
  }
  return 'Max turns reached.';
}

// ── Central tool dispatcher ────────────────────────────────────────────────────
async function dispatchTool(name: string, args: Record<string,string>, ghToken: string, sbToken: string, sbUrl: string, vrToken: string): Promise<string> {
  const schema = TOOL_REGISTRY.find(s => s.name === name);
  if (!schema) return `Unknown tool: ${name}`;
  try {
    switch (schema.category) {
      case 'github':   return await executeGithubTool(name, args, ghToken);
      case 'mcp':      return await executeMcpTool(name, args);
      case 'supabase': return await executeSupabaseTool(name, args, sbToken, sbUrl);
      case 'vercel':   return await executeVercelTool(name, args, vrToken);
      case 'cli':      return await executeCliTool(name, args);
      default:         return `No executor for: ${schema.category}`;
    }
  } catch (e) {
    return `Error in ${name}: ${e instanceof Error ? e.message : 'Unknown error'}`;
  }
}

// ── GitHub Tools ──────────────────────────────────────────────────────────────
async function executeGithubTool(name: string, args: Record<string,string>, userGhToken?: string): Promise<string> {
  const token = userGhToken || process.env.GITHUB_TOKEN;
  if (!token) return 'Error: GitHub not connected. Go to the Connect tab and link your GitHub account.';

  const gh = { Authorization:`Bearer ${token}`, Accept:'application/vnd.github.v3+json', 'User-Agent':'AIAgent/1.0', 'Content-Type':'application/json' };
  const t = <T>(p: Promise<T>) => Promise.race([p, new Promise<T>((_,r)=>setTimeout(()=>r(new Error('GitHub API timeout')), TOOL_TIMEOUT_MS))]);

  if (name === 'list_github_directory') {
    const { repo, path='' } = args;
    const res = await t(fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers:gh }));
    if (!(res as Response).ok) { const e=await (res as Response).json().catch(()=>({})) as {message?:string}; return `Error: ${e.message||(res as Response).statusText} (${(res as Response).status})`; }
    const data = await (res as Response).json();
    if (!Array.isArray(data)) return 'That path is a file — use read_github_file instead.';
    const items = (data as Array<{name:string;type:string;size:number;path:string}>)
      .sort((a,b)=>(a.type==='dir'?-1:1)-(b.type==='dir'?-1:1)||a.name.localeCompare(b.name))
      .map(f=>`${f.type==='dir'?'📁':'📄'} ${f.name}${f.type==='file'?` (${f.size}B)`:''} [${f.path}]`);
    return `📂 ${repo}/${path||''} — ${items.length} items\n\n${items.join('\n')}`;
  }

  if (name === 'read_github_file') {
    const { repo, path, ref } = args;
    const res = await t(fetch(`https://api.github.com/repos/${repo}/contents/${path}${ref?`?ref=${ref}`:''}`, { headers:gh }));
    if (!(res as Response).ok) { const e=await (res as Response).json().catch(()=>({})) as {message?:string}; return `Error reading ${path}: ${e.message||(res as Response).statusText} (${(res as Response).status})`; }
    const data = await (res as Response).json();
    if (Array.isArray(data)) return 'That is a directory — use list_github_directory.';
    if (!data.content) return 'File is empty or binary.';
    const content = Buffer.from(data.content,'base64').toString('utf-8');
    _estimatedTokens += Math.ceil(content.length / 4);
    return `📄 ${data.path} | sha:${data.sha} | ${data.size}B\n\`\`\`\n${content}\n\`\`\``;
  }

  if (name === 'write_github_file') {
    const { repo, path, content, message, sha, branch } = args;
    const body: Record<string,string> = { message, content:Buffer.from(content,'utf-8').toString('base64') };
    if (sha) body.sha = sha;
    if (branch) body.branch = branch;
    const res = await t(fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { method:'PUT', headers:gh, body:JSON.stringify(body) }));
    if (!(res as Response).ok) {
      const e=await (res as Response).json().catch(()=>({})) as {message?:string};
      if ((res as Response).status===409||(e.message||'').includes('sha')) return 'SHA mismatch — call read_github_file first to get the current SHA, then retry.';
      return `Error writing ${path}: ${e.message||(res as Response).statusText} (${(res as Response).status})`;
    }
    const data = await (res as Response).json();
    return `✅ ${sha?'Updated':'Created'} \`${path}\` — commit \`${data.commit?.sha?.slice(0,7)}\``;
  }

  if (name === 'delete_github_file') {
    const { repo, path, sha, message, branch } = args;
    const body: Record<string,string> = { message, sha };
    if (branch) body.branch = branch;
    const res = await t(fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { method:'DELETE', headers:gh, body:JSON.stringify(body) }));
    if (!(res as Response).ok) { const e=await (res as Response).json().catch(()=>({})) as {message?:string}; return `Error: ${e.message||(res as Response).statusText}`; }
    const data = await (res as Response).json();
    return `🗑️ Deleted \`${path}\` — commit \`${data.commit?.sha?.slice(0,7)}\``;
  }

  if (name === 'search_github_code') {
    const res = await t(fetch(`https://api.github.com/search/code?q=${encodeURIComponent(args.query)}&per_page=8`, { headers:{...gh,Accept:'application/vnd.github.v3.text-match+json'} }));
    if (!(res as Response).ok) { const e=await (res as Response).json().catch(()=>({})) as {message?:string}; return `Search error: ${e.message||(res as Response).statusText}`; }
    const data = await (res as Response).json();
    if (!data.items?.length) return `No results for: "${args.query}"`;
    return `Found ${data.total_count} for "${args.query}":\n\n`+(data.items as Array<{path:string;repository:{full_name:string};text_matches?:Array<{fragment:string}>}>).slice(0,8).map(i=>`${i.repository.full_name}/${i.path}\n  ${i.text_matches?.[0]?.fragment?.slice(0,120)||''}`).join('\n\n');
  }

  if (name === 'create_github_pr') {
    const { repo, title, body:prBody, head, base='main' } = args;
    const res = await t(fetch(`https://api.github.com/repos/${repo}/pulls`, { method:'POST', headers:gh, body:JSON.stringify({title,body:prBody,head,base}) }));
    if (!(res as Response).ok) { const e=await (res as Response).json().catch(()=>({})) as {message?:string}; return `Error: ${e.message||(res as Response).statusText}`; }
    const data = await (res as Response).json();
    return `✅ PR #${data.number} — "${data.title}"\n${data.html_url}`;
  }

  if (name === 'create_github_issue') {
    const { repo, title, body:issueBody, labels } = args;
    const payload: Record<string,unknown> = { title, body:issueBody };
    if (labels) payload.labels = labels.split(',').map(l=>l.trim());
    const res = await t(fetch(`https://api.github.com/repos/${repo}/issues`, { method:'POST', headers:gh, body:JSON.stringify(payload) }));
    if (!(res as Response).ok) { const e=await (res as Response).json().catch(()=>({})) as {message?:string}; return `Error: ${e.message||(res as Response).statusText}`; }
    const data = await (res as Response).json();
    return `✅ Issue #${data.number} — "${data.title}"\n${data.html_url}`;
  }

  if (name === 'get_github_commits') {
    const { repo, path:fp, count='10' } = args;
    let url = `https://api.github.com/repos/${repo}/commits?per_page=${count}`;
    if (fp) url += `&path=${encodeURIComponent(fp)}`;
    const res = await t(fetch(url, { headers:gh }));
    if (!(res as Response).ok) return `Error: ${(res as Response).statusText}`;
    const commits = await (res as Response).json() as Array<{sha:string;commit:{message:string;author:{name:string;date:string}}}>;
    return commits.map(c=>`\`${c.sha.slice(0,7)}\` ${c.commit.message.split('\n')[0].slice(0,70)} — ${c.commit.author.name} (${c.commit.author.date.slice(0,10)})`).join('\n');
  }

  if (name === 'get_github_diff') {
    const { repo, sha, base, head } = args;
    const url = sha ? `https://api.github.com/repos/${repo}/commits/${sha}` : `https://api.github.com/repos/${repo}/compare/${base}...${head}`;
    const res = await t(fetch(url, { headers:{...gh,Accept:'application/vnd.github.v3.diff'} }));
    if (!(res as Response).ok) return `Error: ${(res as Response).statusText}`;
    return ((await (res as Response).text()).slice(0,8000)) || '(empty diff)';
  }

  return `Unknown GitHub tool: ${name}`;
}

// ── MCP Tools ─────────────────────────────────────────────────────────────────
async function executeMcpTool(name: string, args: Record<string,string>): Promise<string> {
  if (name === 'mcp_fetch_url') {
    const { url, max_length='8000' } = args;
    try {
      const p = new URL(url);
      const blocked = ['localhost','127.0.0.1','0.0.0.0','169.254.169.254','::1'];
      if (blocked.some(b=>p.hostname===b||p.hostname.startsWith(b))) return `Blocked: cannot fetch internal address ${p.hostname}`;
      if (!['http:','https:'].includes(p.protocol)) return 'Blocked: only http/https allowed';
    } catch { return 'Invalid URL'; }
    const res = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0 AIAgent/1.0'}, signal:AbortSignal.timeout(15000) });
    if (!res.ok) return `HTTP ${res.status} for ${url}`;
    const html = await res.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,parseInt(max_length)) || '(empty page)';
  }
  if (name === 'mcp_remember') { _agentMemory[args.key] = args.value; return `✅ Remembered: ${args.key}`; }
  if (name === 'mcp_recall')   return _agentMemory[args.key] !== undefined ? `${args.key}: ${_agentMemory[args.key]}` : `No value for key: ${args.key}`;
  return `Unknown MCP tool: ${name}`;
}

// ── Supabase Tools ────────────────────────────────────────────────────────────
async function executeSupabaseTool(name: string, args: Record<string,string>, sbToken: string, sbUrl: string): Promise<string> {
  if (!sbToken||!sbUrl) return 'Supabase not connected. Add your URL and token in the Connect tab.';
  const h = { apikey:sbToken, Authorization:`Bearer ${sbToken}`, 'Content-Type':'application/json', Prefer:'return=representation' };
  const base = `${sbUrl}/rest/v1`;
  if (name==='list_supabase_tables') {
    const res=await fetch(`${base}/?apikey=${sbToken}`);
    if(!res.ok) return `Supabase error: ${res.statusText}`;
    const data=await res.json();
    const tables=Object.keys(data?.definitions||data?.paths||{}).filter(k=>!k.startsWith('/')).slice(0,30);
    return tables.length?`Tables: ${tables.join(', ')}`:'Could not list tables — check Supabase token.';
  }
  if (name==='query_supabase') {
    const {table,select='*',filter,limit='50'}=args;
    let url=`${base}/${table}?select=${select}&limit=${limit}`;
    if(filter){try{const f=JSON.parse(filter);Object.entries(f).forEach(([k,v])=>{url+=`&${k}=eq.${v}`;});}catch{return 'filter must be valid JSON';}}
    const res=await fetch(url,{headers:h});
    if(!res.ok) return `Query error: ${res.statusText} (${res.status})`;
    const data=await res.json();
    return `${Array.isArray(data)?data.length:0} rows:\n\`\`\`json\n${JSON.stringify(data,null,2).slice(0,3000)}\n\`\`\``;
  }
  if (name==='insert_supabase_row') {
    const {table,data}=args; let p:unknown; try{p=JSON.parse(data);}catch{return 'data must be valid JSON';}
    const res=await fetch(`${base}/${table}`,{method:'POST',headers:h,body:JSON.stringify(p)});
    if(!res.ok) return `Insert error: ${await res.text()}`;
    return `✅ Inserted: ${JSON.stringify(await res.json()).slice(0,300)}`;
  }
  if (name==='update_supabase_rows') {
    const {table,filter,data}=args; let url=`${base}/${table}?`;
    try{const f=JSON.parse(filter);Object.entries(f).forEach(([k,v])=>{url+=`&${k}=eq.${v}`;});}catch{return 'filter must be valid JSON';}
    let p:unknown; try{p=JSON.parse(data);}catch{return 'data must be valid JSON';}
    const res=await fetch(url,{method:'PATCH',headers:h,body:JSON.stringify(p)});
    if(!res.ok) return `Update error: ${await res.text()}`;
    return `✅ Updated rows`;
  }
  if (name==='delete_supabase_rows') {
    const {table,filter}=args; let url=`${base}/${table}?`;
    try{const f=JSON.parse(filter);Object.entries(f).forEach(([k,v])=>{url+=`&${k}=eq.${v}`;});}catch{return 'filter must be valid JSON';}
    const res=await fetch(url,{method:'DELETE',headers:h});
    if(!res.ok) return `Delete error: ${await res.text()}`;
    return '✅ Deleted matching rows';
  }
  return `Unknown Supabase tool: ${name}`;
}

// ── Vercel Tools ──────────────────────────────────────────────────────────────
async function executeVercelTool(name: string, args: Record<string,string>, vrToken: string): Promise<string> {
  if (!vrToken) return 'Vercel not connected. Add your token in the Connect tab.';
  const h = { Authorization:`Bearer ${vrToken}`, 'Content-Type':'application/json' };
  if (name==='list_vercel_projects') {
    const res=await fetch('https://api.vercel.com/v9/projects?limit=20',{headers:h});
    if(!res.ok) return `Vercel error: ${res.statusText}`;
    const data=await res.json();
    return (data.projects as Array<{name:string;id:string;framework:string}>).map(p=>`${p.name} (${p.id}) — ${p.framework||'unknown'}`).join('\n')||'No projects.';
  }
  if (name==='list_vercel_deployments') {
    const res=await fetch(`https://api.vercel.com/v6/deployments?projectId=${args.projectId}&limit=${args.limit||5}`,{headers:h});
    if(!res.ok) return `Vercel error: ${res.statusText}`;
    const data=await res.json();
    return (data.deployments as Array<{state:string;url:string;createdAt:number}>).map(d=>`${d.state} | ${d.url} | ${new Date(d.createdAt).toISOString().slice(0,16)}`).join('\n');
  }
  if (name==='get_vercel_env_vars') {
    const res=await fetch(`https://api.vercel.com/v10/projects/${args.projectId}/env`,{headers:h});
    if(!res.ok) return `Vercel error: ${res.statusText}`;
    const data=await res.json();
    return (data.envs as Array<{key:string;target:string[]}>).map(e=>`${e.key} [${e.target.join(',')}]`).join('\n')||'No env vars.';
  }
  if (name==='add_vercel_env_var') {
    const targets=(args.target||'production,preview').split(',').map(t=>t.trim());
    const res=await fetch(`https://api.vercel.com/v10/projects/${args.projectId}/env`,{method:'POST',headers:h,body:JSON.stringify({key:args.key,value:args.value,target:targets,type:'plain'})});
    if(!res.ok) return `Vercel error: ${await res.text()}`;
    return `✅ Added ${args.key} → [${targets.join(',')}]`;
  }
  if (name==='trigger_vercel_redeploy') {
    const res=await fetch('https://api.vercel.com/v13/deployments?forceNew=1',{method:'POST',headers:h,body:JSON.stringify({deploymentId:args.deploymentId})});
    if(!res.ok) return `Redeploy error: ${await res.text()}`;
    const data=await res.json();
    return `✅ Redeploying: ${data.url||args.deploymentId}`;
  }
  return `Unknown Vercel tool: ${name}`;
}

// ── CLI Tools ─────────────────────────────────────────────────────────────────
async function executeCliTool(name: string, args: Record<string,string>): Promise<string> {
  if (name === 'run_shell_command') {
    const { command } = args;
    const blocked = ['rm -rf /', 'sudo rm', ':(){', '> /dev/sd', '/etc/shadow', '/etc/passwd'];
    for (const b of blocked) { if (command.includes(b)) return `Blocked: "${b}" not permitted`; }
    try {
      const { stdout, stderr } = await execAsync(command, { timeout:15000, cwd:'/tmp' });
      return (stdout + (stderr?`\nSTDERR: ${stderr}`:'')).trim() || '(no output)';
    } catch (e: unknown) {
      const ex = e as {stdout?:string;stderr?:string;message?:string};
      return ex.stdout || ex.stderr || ex.message || 'Command failed';
    }
  }
  return `Unknown CLI tool: ${name}`;
}

// ── POST /api/chat ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // Rate limit: 20 req/60s per IP
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  const rl = rateLimit(ip, 'chat', 20, 60);
  if (!rl.ok) return NextResponse.json({ error:`Rate limit: retry in ${rl.retryAfter}s.` }, { status:429, headers:{'Retry-After':String(rl.retryAfter)} });

  try {
    const { message, history, settings } = await req.json();
    if (!message || typeof message !== 'string') return NextResponse.json({ error:'message is required' }, { status:400 });
    if (message.length > 50_000) return NextResponse.json({ error:'Message too long (max 50000 chars)' }, { status:400 });

    // Auto-detect pasted tokens
    for (const { pattern, field, label } of KEY_PATTERNS) {
      const match = message.match(pattern);
      if (match) return NextResponse.json({ text:`Got it — ${label} saved ✓. You can now use that integration.`, detected_keys:[{field,value:match[0]}] });
    }
    const sbUrlMatch = message.match(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    if (sbUrlMatch) return NextResponse.json({ text:'Supabase URL saved ✓', detected_keys:[{field:'supabase_url',value:sbUrlMatch[0]}] });

    // Extract settings
    const apiKey       = settings?.is_custom_gemini_key_enabled && settings?.custom_gemini_api_key ? settings.custom_gemini_api_key : process.env.GEMINI_API_KEY;
    const useSearch    = !!settings?.enable_web_search;
    const sbToken      = (settings?.supabase_access_token || '') as string;
    const sbUrl        = (settings?.supabase_url || process.env.NEXT_PUBLIC_SUPABASE_URL || '') as string;
    const vrToken      = (settings?.vercel_access_token || '') as string;
    const userGhToken  = (settings?.github_token || '') as string;
    const hasSb = !!(sbToken && sbUrl);
    const hasVr = !!vrToken;
    const hasGh = !!userGhToken;
    const requested = settings?.active_model_name || 'gemini-2.5-flash';

    // Dynamic tool selection (token conservation)
    const activeSchemas = selectActiveTools(message, hasGh, hasSb, hasVr);

    // Build contextual system prompt
    let systemCtx = SYSTEM_PROMPT;
    if (hasGh && settings?.github_username) systemCtx += `\n\n## CONNECTED GITHUB\nUsername: ${settings.github_username}\nWhen user says "my repo" or omits owner, use ${settings.github_username}.`;
    if (hasSb) systemCtx += `\n\n## CONNECTED SUPABASE\nURL: ${sbUrl}`;
    if (hasVr) systemCtx += `\n\n## CONNECTED VERCEL\nToken available.`;

    const baseContents = [
      ...(history||[]).map((h:{role:string;text:string})=>({ role:h.role==='assistant'?'model':h.role, parts:[{text:h.text}] })),
      { role:'user', parts:[{text:message}] },
    ];

    // HuggingFace (single-shot)
    if (requested.startsWith('hf:')) {
      const hfModelId = HF_MODELS[requested] ?? requested.slice(3);
      const hfMsgs = [
        {role:'system',content:systemCtx},
        ...(history||[]).map((h:{role:string;text:string})=>({role:h.role==='model'?'assistant':h.role,content:h.text})),
        {role:'user',content:message},
      ];
      try {
        const answer = await callHuggingFace(settings?.hf_api_key||process.env.HF_TOKEN||null, hfModelId, hfMsgs);
        return NextResponse.json({ text:answer, model:hfModelId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'HuggingFace error';
        return NextResponse.json({ error: msg.includes('401')||msg.includes('403') ? 'HuggingFace token required — get one free at huggingface.co/settings/tokens' : msg }, { status:500 });
      }
    }

    // GitHub Models (full agentic tool loop)
    if (requested.startsWith('gh:')) {
      const ghModelId = GITHUB_MODELS[requested] ?? requested.slice(3);
      const ghToken = userGhToken || process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '';
      if (!ghToken) return NextResponse.json({ error:'Connect GitHub in the Connect tab to use GitHub Models (GPT-4o etc.) for free.' }, { status:401 });
      const ghMsgs = [
        ...(history||[]).map((h:{role:string;text:string})=>({role:h.role==='model'?'assistant':h.role,content:h.text})),
        {role:'user',content:message},
      ];
      try {
        const answer = await runGitHubModelsLoop(ghToken, ghModelId, ghMsgs, systemCtx, activeSchemas, userGhToken, sbToken, sbUrl, vrToken);
        return NextResponse.json({ text:answer, model:ghModelId });
      } catch (e) {
        return NextResponse.json({ error:e instanceof Error?e.message:'GitHub Models error' }, { status:500 });
      }
    }

    // Gemini (state-graph loop with circuit breaker)
    if (!apiKey) return NextResponse.json({ error:'No Gemini API key. Switch to a GitHub Model in Model Settings (free) or add a Gemini key.' }, { status:401 });

    const geminiTools = buildGeminiTools(activeSchemas, useSearch);
    let geminiRes: Response|null = null;
    let usedModel = requested;

    for (const model of [requested, ...GEMINI_FALLBACKS.filter(m=>m!==requested)]) {
      const res = await callGemini(apiKey, model, baseContents, geminiTools, systemCtx);
      if (res.ok) { geminiRes=res; usedModel=model; break; }
      const errText = await res.text();
      let errCode: number|undefined;
      try { errCode=JSON.parse(errText)?.error?.code; } catch { /* ignore */ }
      if (errCode!==503 && errCode!==429 && errCode!==404) {
        let msg = errText;
        try { const p=JSON.parse(errText); msg=p?.error?.message||p?.message||errText; } catch { /* ignore */ }
        return NextResponse.json({ error:`Gemini: ${msg.slice(0,300)}` }, { status:500 });
      }
    }

    // Gemini quota exhausted → auto-fallback GitHub Models
    if (!geminiRes) {
      const ghFallback = userGhToken || process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '';
      if (ghFallback) {
        const ghMsgs = [
          ...(history||[]).map((h:{role:string;text:string})=>({role:h.role==='model'?'assistant':h.role,content:h.text})),
          {role:'user',content:message},
        ];
        try {
          const answer = await runGitHubModelsLoop(ghFallback,'gpt-4o',ghMsgs,systemCtx,activeSchemas,userGhToken,sbToken,sbUrl,vrToken);
          return NextResponse.json({ text:answer, model:'gpt-4o (auto-fallback)' });
        } catch { /* fall through */ }
      }
      return NextResponse.json({ error:'Gemini quota reached. Connect GitHub for free GPT-4o access.' }, { status:429 });
    }

    // ── Gemini state-graph agentic loop ───────────────────────────────────
    let currentContents = [...baseContents];
    let currentRes = geminiRes;
    _estimatedTokens = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Token budget circuit breaker
      if (_estimatedTokens > MAX_COST_TOKENS) {
        return NextResponse.json({ text:`⚠️ Token budget reached (~${(_estimatedTokens/1000).toFixed(0)}k tokens). Here's what I found — ask me to continue on specific files.` });
      }

      const geminiData = await currentRes.json();
      if (geminiData.error) return NextResponse.json({ error:geminiData.error.message||'Gemini error' }, { status:500 });

      const candidate = geminiData.candidates?.[0];
      const parts: Array<{text?:string;functionCall?:{name:string;args:Record<string,string>}}> = candidate?.content?.parts || [];
      const fnCalls = parts.filter(p=>p.functionCall);

      if (fnCalls.length === 0) {
        // Terminal turn
        let text = parts.filter(p=>p.text).map(p=>p.text!).join('\n').trim();

        // Self-correction: empty text after tool use → force summary
        if (!text && turn > 0) {
          currentContents = [...currentContents, {role:'model',parts}, {role:'user',parts:[{text:SUMMARY_PROMPT}]}];
          currentRes = await callGemini(apiKey, usedModel, currentContents, geminiTools, systemCtx);
          if (!currentRes.ok) break;
          const sd = await currentRes.json();
          const sp = sd.candidates?.[0]?.content?.parts||[];
          text = sp.filter((p:{text?:string})=>p.text).map((p:{text?:string})=>p.text!).join('\n').trim();
        }

        if (!text) text = 'Task completed. What would you like me to do next?';
        if (usedModel !== requested) text += `\n\n_(auto-switched to ${usedModel} — ${requested} was unavailable)_`;

        // Grounding sources
        const chunks = candidate?.groundingMetadata?.groundingChunks;
        if (chunks?.length) {
          const sources = (chunks as Array<{web?:{uri:string;title:string}}>).slice(0,5).map(c=>c.web?`[${c.web.title||c.web.uri}](${c.web.uri})`:null).filter(Boolean).join(' · ');
          if (sources) text += `\n\n🔍 Sources: ${sources}`;
        }

        return NextResponse.json({ text });
      }

      // Execute tool calls (parallel, with validation)
      const toolResults = await Promise.all(
        fnCalls.map(async p => {
          const fn = p.functionCall!;
          const val = validateToolArgs(fn.name, fn.args||{});
          let result: string;
          if (!val.ok) {
            result = `Validation error: ${val.error}`;
          } else {
            result = await dispatchTool(fn.name, fn.args||{}, userGhToken, sbToken, sbUrl, vrToken);
          }
          _estimatedTokens += Math.ceil(result.length / 4);
          return { functionResponse: { name:fn.name, response:{ result } } };
        })
      );

      currentContents = [...currentContents, {role:'model',parts}, {role:'user',parts:toolResults}];
      currentRes = await callGemini(apiKey, usedModel, currentContents, geminiTools, systemCtx);
      if (!currentRes.ok) {
        return NextResponse.json({ error:`Gemini error on turn ${turn+1}: ${(await currentRes.text()).slice(0,200)}` }, { status:500 });
      }
    }

    return NextResponse.json({ error:'Max turns reached. Break the task into smaller steps.' }, { status:500 });

  } catch (e: unknown) {
    return NextResponse.json({ error:e instanceof Error?e.message:'Internal server error' }, { status:500 });
  }
}
