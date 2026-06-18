/**
 * web/app/api/chat/route.ts
 *
 * Autonomous Agent — Hierarchical Multi-Agent Orchestration Engine
 * ──────────────────────────────────────────────────────────────────────────
 * Architecture:
 *   • Supervisor router selects specialist agent per turn (architect/coder/
 *     debugger/tester/deployer/researcher)
 *   • Workspace skills injected into system prompts automatically
 *   • Procedural state serialised on every turn (resumable on failure)
 *   • Interactive "Ask Human" flow: pauses when stuck, resumes from exact step
 *   • Circuit breaker: MAX_TURNS + 200k token budget cap
 *   • Self-correction: forces summary turn on empty model output
 *   • Multi-provider: Gemini (primary) → GitHub Models (fallback) → HF
 *   • Rate limiting (20 req/60s per IP)
 *   • Dynamic tool filtering saves ~80% tokens per turn
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { rateLimit } from '@/lib/rateLimit';
import { supervisorRoute, buildAgentSystemPrompt, extractEscalation, type ExecutionContext } from '@/lib/orchestrator';
import { createState, updateState, pauseForHuman } from '@/lib/agentState';
import { selectActiveSkills, buildSkillsBlock } from '@/lib/workspaceSkills';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

const execAsync = promisify(exec);

// ── Circuit breaker constants ────────────────────────────────────────────────
const MAX_TURNS        = 15;
const MAX_COST_TOKENS  = 200_000;
const TOOL_TIMEOUT_MS  = 20_000;
const SUMMARY_PROMPT   = 'Summarise EVERYTHING you found and did: every file read, every bug found, every change made, every commit pushed. Be specific. Never say just "Done."';

// ── In-process memory ────────────────────────────────────────────────────────
const _agentMemory: Record<string, string> = {};
let _estimatedTokens = 0;

// ── Tool Schema Registry (runtime validation) ───────────────────────────────
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
  { name: 'write_github_file',     description: 'Create or update a file. REQUIRES sha param for existing files (get it from read_github_file first).', params: { repo:{type:'string'}, path:{type:'string'}, content:{type:'string'}, message:{type:'string'}, sha:{type:'string'}, branch:{type:'string'} }, required: ['repo','path','content','message'], category: 'github' },
  { name: 'delete_github_file',    description: 'Delete a file from a GitHub repo.', params: { repo:{type:'string'}, path:{type:'string'}, message:{type:'string'}, sha:{type:'string'} }, required: ['repo','path','message','sha'], category: 'github' },
  { name: 'search_github_code',    description: 'Search code across a GitHub repo.', params: { query:{type:'string'}, repo:{type:'string'} }, required: ['query'], category: 'github' },
  { name: 'create_github_branch',  description: 'Create a new branch in a GitHub repo.', params: { repo:{type:'string'}, branch:{type:'string'}, from_branch:{type:'string'} }, required: ['repo','branch'], category: 'github' },
  { name: 'create_github_pr',      description: 'Create a pull request.', params: { repo:{type:'string'}, title:{type:'string'}, head:{type:'string'}, base:{type:'string'}, body:{type:'string'} }, required: ['repo','title','head','base'], category: 'github' },
  // MCP
  { name: 'mcp_fetch_url',  description: 'Fetch a URL as clean text.', params: { url:{type:'string'}, max_length:{type:'string'} }, required: ['url'], category: 'mcp' },
  { name: 'mcp_remember',   description: 'Store a key/value in memory.', params: { key:{type:'string'}, value:{type:'string'} }, required: ['key','value'], category: 'mcp' },
  { name: 'mcp_recall',     description: 'Retrieve a stored memory by key.', params: { key:{type:'string'} }, required: ['key'], category: 'mcp' },
  // Supabase
  { name: 'execute_supabase_sql', description: 'Execute a SQL query on the connected Supabase project.', params: { sql:{type:'string'}, project_ref:{type:'string'} }, required: ['sql'], category: 'supabase' },
  { name: 'list_supabase_tables', description: 'List all tables in the connected Supabase project.', params: { project_ref:{type:'string'} }, required: [], category: 'supabase' },
  // Vercel
  { name: 'list_vercel_projects',    description: 'List Vercel projects for the connected account.', params: {}, required: [], category: 'vercel' },
  { name: 'get_vercel_deployments',  description: 'Get recent deployments for a Vercel project.', params: { project_id:{type:'string'} }, required: ['project_id'], category: 'vercel' },
  { name: 'trigger_vercel_redeploy', description: 'Trigger a redeployment of a Vercel project.', params: { deployment_id:{type:'string'} }, required: ['deployment_id'], category: 'vercel' },
  // CLI / System
  { name: 'run_cli_command', description: 'Run a safe shell command (git, npm, node, npx). No sudo/rm -rf.', params: { command:{type:'string'} }, required: ['command'], category: 'cli' },
];

// ── Gemini tool format ────────────────────────────────────────────────────────
function buildGeminiTools(allowedCategories: string[]): object[] {
  const filtered = allowedCategories.length > 0
    ? TOOL_REGISTRY.filter(t => allowedCategories.includes(t.category))
    : TOOL_REGISTRY;

  const props: Record<string, object> = {};
  const required: string[] = [];

  // Build as single functionDeclarations block
  return [{
    functionDeclarations: filtered.map(tool => ({
      name:       tool.name,
      description: tool.description,
      parameters: {
        type: 'OBJECT',
        properties: Object.fromEntries(
          Object.entries(tool.params).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: k }]),
        ),
        required: tool.required,
      },
    })),
  }];
}

// ── Gemini content builder ────────────────────────────────────────────────────
function buildContents(messages: { role: string; content: string }[]) {
  return messages
    .filter(m => m.content?.trim())
    .map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // Rate limiting
  const ip = (req.headers.get('x-forwarded-for') ?? '127.0.0.1').split(',')[0].trim();
  const rl  = rateLimit(ip, 'chat', 20, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${rl.retryAfter}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  let requestBody: {
    messages?:    { role: string; content: string }[];
    sessionId?:   string;
    settings?:    Record<string, string | boolean>;
    stateId?:     string;  // resume from existing state
    userReply?:   string;  // user reply to an Ask Human request
  };

  try {
    requestBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    messages = [],
    sessionId = `anon_${Date.now()}`,
    settings = {},
    stateId: existingStateId,
    userReply,
  } = requestBody;

  if (!messages.length) {
    return NextResponse.json({ error: 'messages array is required' }, { status: 400 });
  }

  // ── Resolve API key ─────────────────────────────────────────────────────
  const geminiKey =
    (settings.is_custom_gemini_key_enabled && settings.custom_gemini_api_key as string) ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_KEY ||
    '';

  const modelName = (settings.active_model_name as string) || 'gemini-2.5-flash';
  const githubToken = (settings.github_token as string) || process.env.GITHUB_TOKEN || '';

  // ── Build / restore execution state ────────────────────────────────────
  const userGoal = messages.find(m => m.role === 'user')?.content ?? 'No goal specified';
  let execState = existingStateId
    ? await import('@/lib/agentState').then(m => m.loadState(existingStateId)).then(s => s ?? createState(sessionId, userGoal))
    : createState(sessionId, userGoal);

  // If this is a resume from Ask Human, patch the state
  if (userReply && existingStateId) {
    await import('@/lib/agentState').then(m => m.resolveHumanRequest(existingStateId, userReply));
    execState = await import('@/lib/agentState').then(m =>
      m.updateState(execState.stateId, {
        activeRole:  'coder',
        pendingTasks: [...execState.pendingTasks, `User replied: ${userReply}`],
      }).then(s => s ?? execState),
    );
  }

  // ── Supervisor routing ──────────────────────────────────────────────────
  const executionCtx: ExecutionContext = {
    sessionId,
    goal:             userGoal,
    currentStep:      messages[messages.length - 1]?.content ?? '',
    history:          execState.errorLog,
    errorCount:       execState.errorLog.length,
    pendingSkills:    execState.activeSkills,
    activeConnectors: execState.resolvedVars ? Object.keys(execState.resolvedVars) : [],
  };

  const routingDecision = supervisorRoute(executionCtx);
  const activeRole = routingDecision.role;

  // ── Load workspace skills for this context ──────────────────────────────
  const contextText = `${userGoal} ${executionCtx.currentStep}`;
  const activeSkills = await selectActiveSkills(sessionId, contextText);
  const skillsBlock  = buildSkillsBlock(activeSkills);

  // ── Build system prompt with role + skills ──────────────────────────────
  const agentPromptFragment = buildAgentSystemPrompt(activeRole, activeSkills.map(s => s.name));
  const systemPrompt = [
    agentPromptFragment,
    '',
    'You are operating as part of the Monico Agent Studio workspace.',
    'Tools available depend on your role. Use them methodically.',
    'When you encounter an error, try to fix it up to 2 times, then emit ESCALATE_TO_HUMAN:<reason>.',
    '',
    skillsBlock,
    '',
    '── Session Context ──',
    `Session ID: ${sessionId}`,
    `Goal: ${userGoal}`,
    `Current role: ${activeRole} (confidence: ${routingDecision.confidence})`,
    `Routing reason: ${routingDecision.reasoning}`,
    `Step index: ${execState.stepIndex}`,
    userReply ? `User feedback (resume): ${userReply}` : '',
    '',
    Object.keys(_agentMemory).length
      ? `── Memory ──\n${Object.entries(_agentMemory).map(([k,v]) => `${k}: ${v}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  // ── Agent role → allowed tool categories ───────────────────────────────
  const roleCategories: Record<string, string[]> = {
    architect:  ['github', 'mcp', 'cli'],
    coder:      ['github', 'mcp', 'cli', 'supabase'],
    debugger:   ['github', 'mcp', 'cli'],
    tester:     ['github', 'cli'],
    deployer:   ['vercel', 'supabase', 'github', 'cli'],
    researcher: ['mcp', 'cli'],
    supervisor: [], // supervisor doesn't call tools directly
  };
  const allowedCategories = roleCategories[activeRole] ?? [];
  const tools = buildGeminiTools(allowedCategories);

  // ── Token estimation ────────────────────────────────────────────────────
  _estimatedTokens = Math.floor(
    systemPrompt.length / 4 +
    messages.reduce((s, m) => s + (m.content?.length ?? 0) / 4, 0),
  );

  // ── Streaming response ──────────────────────────────────────────────────
  const encoder  = new TextEncoder();
  let toolCalls: { name: string; args: Record<string, unknown>; result?: string }[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      try {
        // Emit routing metadata to client
        send(`data: ${JSON.stringify({
          type: 'routing',
          role: activeRole,
          confidence: routingDecision.confidence,
          reasoning: routingDecision.reasoning,
          activeSkills: activeSkills.map(s => s.name),
        })}\n\n`);

        let conversationMessages = buildContents(messages);
        let turns = 0;
        let lastText = '';

        while (turns < MAX_TURNS && _estimatedTokens < MAX_COST_TOKENS) {
          turns++;

          // ── Call Gemini ──────────────────────────────────────────────
          let geminiRes: Response;
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;
          const geminiBody = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents:           conversationMessages,
            tools,
            generationConfig: {
              temperature:     0.7,
              maxOutputTokens: 8192,
            },
          };

          try {
            geminiRes = await fetch(endpoint, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(geminiBody),
              signal:  AbortSignal.timeout(60_000),
            });
          } catch (fetchErr) {
            const msg = fetchErr instanceof Error ? fetchErr.message : 'Network error';
            send(`data: ${JSON.stringify({ type: 'error', content: `Gemini connection failed: ${msg}` })}\n\n`);
            break;
          }

          if (!geminiRes.ok) {
            const errText = await geminiRes.text().catch(() => '');
            // Fallback to GitHub Models if Gemini is unavailable
            const fallbackResult = await tryGithubModelsFallback(
              systemPrompt, messages, githubToken,
            );
            if (fallbackResult) {
              send(`data: ${JSON.stringify({ type: 'text', content: fallbackResult })}\n\n`);
            } else {
              send(`data: ${JSON.stringify({ type: 'error', content: `API error ${geminiRes.status}: ${errText.slice(0, 200)}` })}\n\n`);
            }
            break;
          }

          const geminiData = await geminiRes.json();
          const candidate  = geminiData.candidates?.[0];
          if (!candidate) {
            send(`data: ${JSON.stringify({ type: 'error', content: 'No response from model.' })}\n\n`);
            break;
          }

          // Update token estimate
          if (geminiData.usageMetadata) {
            _estimatedTokens = geminiData.usageMetadata.totalTokenCount ?? _estimatedTokens;
          }

          const parts = candidate.content?.parts ?? [];
          let textThisTurn  = '';
          const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

          for (const part of parts) {
            if (part.text)         textThisTurn += part.text;
            if (part.functionCall) functionCalls.push(part.functionCall);
          }

          // Emit any text
          if (textThisTurn) {
            lastText = textThisTurn;

            // Check for HITL escalation signal
            const escalationReason = extractEscalation(textThisTurn);
            if (escalationReason) {
              // Save state and raise Ask Human
              await updateState(execState.stateId, {
                errorLog: [...execState.errorLog, escalationReason],
              });
              const askReq = await pauseForHuman(execState, escalationReason);
              send(`data: ${JSON.stringify({
                type:       'ask_human',
                stateId:    askReq.stateId,
                resumeStep: askReq.resumeStep,
                reason:     escalationReason,
                errorLog:   execState.errorLog,
              })}\n\n`);
              break;
            }

            // Stream text to client
            for (const chunk of textThisTurn.split(/(?<=\n)/)) {
              send(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
              await new Promise(r => setTimeout(r, 0));
            }
          }

          // Self-correction: force summary if empty
          if (!textThisTurn && !functionCalls.length) {
            conversationMessages.push({
              role:  'user',
              parts: [{ text: SUMMARY_PROMPT }],
            });
            send(`data: ${JSON.stringify({ type: 'system', content: '[Auto-requesting summary after empty response]' })}\n\n`);
            continue;
          }

          // No tool calls → we're done
          if (!functionCalls.length) break;

          // ── Execute tool calls ──────────────────────────────────────────
          conversationMessages.push({ role: 'model', parts });
          const toolResults: object[] = [];

          for (const call of functionCalls) {
            const { name, args } = call;
            send(`data: ${JSON.stringify({ type: 'tool_call', tool: name, args })}\n\n`);

            let result = '';
            try {
              result = await executeTool(name, args, { githubToken, sessionId });
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              result = `Error: ${errMsg}`;
              // Track errors for state
              execState.errorLog.push(`${name}: ${errMsg}`);
              await updateState(execState.stateId, { errorLog: execState.errorLog });
            }

            toolCalls.push({ name, args, result });
            send(`data: ${JSON.stringify({ type: 'tool_result', tool: name, result: result.slice(0, 500) })}\n\n`);

            toolResults.push({
              functionResponse: { name, response: { content: result } },
            });
          }

          conversationMessages.push({ role: 'user', parts: toolResults });
        }

        // Circuit breaker notification
        if (turns >= MAX_TURNS) {
          send(`data: ${JSON.stringify({ type: 'system', content: `[Circuit breaker: reached ${MAX_TURNS} turns]` })}\n\n`);
        }
        if (_estimatedTokens >= MAX_COST_TOKENS) {
          send(`data: ${JSON.stringify({ type: 'system', content: `[Token budget exhausted: ${_estimatedTokens} tokens]` })}\n\n`);
        }

        // Persist final state
        await updateState(execState.stateId, {
          activeRole:   activeRole,
          activeSkills: activeSkills.map(s => s.name),
          stepIndex:    execState.stepIndex + turns,
        });

        send(`data: ${JSON.stringify({
          type:         'done',
          model:        modelName,
          role:         activeRole,
          toolCallCount: toolCalls.length,
          turns,
          estimatedTokens: _estimatedTokens,
          stateId:      execState.stateId,
        })}\n\n`);

      } catch (outerErr: unknown) {
        const msg = outerErr instanceof Error ? outerErr.message : 'Internal error';
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', content: msg })}\n\n`,
        ));
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}

// ── Tool Executor ─────────────────────────────────────────────────────────────
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { githubToken: string; sessionId: string },
): Promise<string> {
  const { githubToken, sessionId } = ctx;

  // ── GitHub tools ─────────────────────────────────────────────────────────
  if (name === 'list_github_directory') {
    const res = await githubApiCall(
      `/repos/${String(args.repo ?? '')}/contents/${String(args.path ?? '')}`,
      githubToken,
    );
    if (!res.ok) return `GitHub error: ${res.status}`;
    const data = await res.json();
    if (Array.isArray(data)) {
      return data.map((f: { name: string; type: string; size: number }) =>
        `${f.type === 'dir' ? '📁' : '📄'} ${f.name} (${f.type}${f.type === 'file' ? `, ${f.size}B` : ''})`
      ).join('\n');
    }
    return JSON.stringify(data).slice(0, 2000);
  }

  if (name === 'read_github_file') {
    const res = await githubApiCall(
      `/repos/${String(args.repo)}/contents/${String(args.path)}${args.ref ? `?ref=${args.ref}` : ''}`,
      githubToken,
    );
    if (!res.ok) return `GitHub error: ${res.status} - ${await res.text()}`;
    const data = await res.json();
    const content = data.content
      ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8')
      : '';
    return `SHA: ${data.sha}\n\n${content.slice(0, 20000)}`;
  }

  if (name === 'write_github_file') {
    const body: Record<string, string> = {
      message: String(args.message ?? 'Update via AI agent'),
      content: Buffer.from(String(args.content ?? '')).toString('base64'),
    };
    if (args.sha)    body.sha    = String(args.sha);
    if (args.branch) body.branch = String(args.branch);

    const res = await githubApiCall(
      `/repos/${String(args.repo)}/contents/${String(args.path)}`,
      githubToken,
      'PUT',
      body,
    );
    const data = await res.json();
    if (!res.ok) return `GitHub write error: ${res.status} — ${data.message ?? JSON.stringify(data)}`;
    return `✅ File written: ${data.content?.html_url ?? String(args.path)}`;
  }

  if (name === 'delete_github_file') {
    const res = await githubApiCall(
      `/repos/${String(args.repo)}/contents/${String(args.path)}`,
      githubToken,
      'DELETE',
      { message: String(args.message ?? 'Delete via AI agent'), sha: String(args.sha ?? '') },
    );
    return res.ok ? `✅ Deleted: ${String(args.path)}` : `Delete error: ${res.status}`;
  }

  if (name === 'search_github_code') {
    const q   = encodeURIComponent(`${String(args.query)} ${args.repo ? `repo:${String(args.repo)}` : ''}`);
    const res = await githubApiCall(`/search/code?q=${q}&per_page=10`, githubToken);
    if (!res.ok) return `Search error: ${res.status}`;
    const data = await res.json();
    const items = (data.items ?? []).slice(0, 8) as Array<{ path: string; html_url: string }>;
    return items.map(i => `${i.path} — ${i.html_url}`).join('\n') || 'No results';
  }

  if (name === 'create_github_branch') {
    // Get SHA of source branch
    const fromBranch = String(args.from_branch ?? 'main');
    const refRes = await githubApiCall(
      `/repos/${String(args.repo)}/git/ref/heads/${fromBranch}`,
      githubToken,
    );
    if (!refRes.ok) return `Could not get ref: ${refRes.status}`;
    const refData = await refRes.json();
    const sha = refData.object?.sha;
    const res = await githubApiCall(
      `/repos/${String(args.repo)}/git/refs`,
      githubToken,
      'POST',
      { ref: `refs/heads/${String(args.branch)}`, sha },
    );
    return res.ok ? `✅ Branch '${String(args.branch)}' created from '${fromBranch}'` : `Branch error: ${res.status}`;
  }

  if (name === 'create_github_pr') {
    const res = await githubApiCall(
      `/repos/${String(args.repo)}/pulls`,
      githubToken,
      'POST',
      {
        title: String(args.title ?? 'AI Agent PR'),
        head:  String(args.head),
        base:  String(args.base ?? 'main'),
        body:  String(args.body ?? ''),
      },
    );
    const data = await res.json();
    return res.ok ? `✅ PR created: ${data.html_url}` : `PR error: ${res.status} — ${data.message}`;
  }

  // ── MCP tools ─────────────────────────────────────────────────────────────
  if (name === 'mcp_fetch_url') {
    const mcpRes = await fetch('/api/mcp', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tool: 'mcp_fetch_url', arguments: args }),
      signal:  AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    const data = await mcpRes.json();
    return data.result ?? data.error ?? 'No result';
  }

  if (name === 'mcp_remember') {
    _agentMemory[String(args.key)] = String(args.value);
    return `Remembered: ${String(args.key)} = ${String(args.value).slice(0, 100)}`;
  }

  if (name === 'mcp_recall') {
    const val = _agentMemory[String(args.key)];
    return val !== undefined ? val : `No memory found for key: ${String(args.key)}`;
  }

  // ── CLI tools ─────────────────────────────────────────────────────────────
  if (name === 'run_cli_command') {
    const cmd = String(args.command ?? '');
    // Security: block dangerous commands
    const BLOCKED = ['rm -rf', 'sudo', 'chmod 777', 'curl | sh', 'wget | sh', '> /dev/'];
    if (BLOCKED.some(b => cmd.includes(b))) {
      return `❌ Blocked: dangerous command pattern detected`;
    }
    const ALLOWED_PREFIXES = ['git ', 'npm ', 'npx ', 'node ', 'ls ', 'cat ', 'echo ', 'pwd', 'find ', 'grep ', 'wc '];
    if (!ALLOWED_PREFIXES.some(p => cmd.startsWith(p))) {
      return `❌ Blocked: only git/npm/npx/node/ls/cat commands are allowed`;
    }
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: TOOL_TIMEOUT_MS });
      return (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).slice(0, 5000);
    } catch (e) {
      const err = e as { message: string; stdout?: string; stderr?: string };
      return `Command failed: ${err.message}\n${err.stderr ?? ''}`.slice(0, 2000);
    }
  }

  // ── Supabase tools ────────────────────────────────────────────────────────
  if (name === 'execute_supabase_sql' || name === 'list_supabase_tables') {
    // Proxy through the Supabase management API
    const sbRes = await fetch('/api/supabase/auth', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: name, ...args }),
      signal:  AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    const data = await sbRes.json();
    return JSON.stringify(data).slice(0, 3000);
  }

  // ── Vercel tools ──────────────────────────────────────────────────────────
  if (name.startsWith('list_vercel') || name.startsWith('get_vercel') || name.startsWith('trigger_vercel')) {
    const vcRes = await fetch('/api/vercel/auth', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: name, ...args }),
      signal:  AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    const data = await vcRes.json();
    return JSON.stringify(data).slice(0, 3000);
  }

  return `Unknown tool: ${name}`;
}

// ── GitHub API helper ─────────────────────────────────────────────────────────
function githubApiCall(
  path: string,
  token: string,
  method = 'GET',
  body?: object,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept:       'application/vnd.github+json',
    'User-Agent': 'MonicaAgentStudio/2.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body)  headers['Content-Type']  = 'application/json';

  return fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
}

// ── GitHub Models fallback ────────────────────────────────────────────────────
async function tryGithubModelsFallback(
  system: string,
  messages: { role: string; content: string }[],
  token: string,
): Promise<string | null> {
  if (!token) return null;
  try {
    const res = await fetch('https://models.github.ai/inference/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${token}`,
      },
      body: JSON.stringify({
        model:    'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}
