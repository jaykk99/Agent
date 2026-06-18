/**
 * web/app/api/chat/route.ts
 *
 * Autonomous Agent — Hierarchical Multi-Agent Orchestration Engine
 * ──────────────────────────────────────────────────────────────────────────
 * Architecture:
 *   • Supervisor router selects specialist agent per turn
 *   • Workspace skills injected into system prompts automatically
 *   • Procedural state serialised on every turn (resumable on failure)
 *   • Interactive "Ask Human" flow: pauses when stuck, resumes from exact step
 *   • Circuit breaker: MAX_TURNS + 200k token budget cap
 *   • Self-correction: forces summary turn on empty model output
 *   • Multi-provider: Gemini · OpenAI · GitHub Models · Anthropic · Groq
 *   • Backward-compatible: accepts { message: string } OR { messages: [...] }
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
let _lastText = '';          // last assistant text turn — included in 'done' for frontend

// ── Supported models registry ────────────────────────────────────────────────
export const SUPPORTED_MODELS = [
  // Gemini (Google)
  { id: 'gemini-2.5-flash',          label: 'Gemini 2.5 Flash',         provider: 'gemini',    tier: 'fast',    toolUse: true  },
  { id: 'gemini-2.5-pro',            label: 'Gemini 2.5 Pro',           provider: 'gemini',    tier: 'smart',   toolUse: true  },
  { id: 'gemini-2.0-flash',          label: 'Gemini 2.0 Flash',         provider: 'gemini',    tier: 'fast',    toolUse: true  },
  { id: 'gemini-1.5-pro',            label: 'Gemini 1.5 Pro',           provider: 'gemini',    tier: 'smart',   toolUse: true  },
  { id: 'gemini-1.5-flash',          label: 'Gemini 1.5 Flash',         provider: 'gemini',    tier: 'fast',    toolUse: true  },
  // OpenAI (via OPENAI_API_KEY or GitHub Models)
  { id: 'gpt-4o',                    label: 'GPT-4o',                   provider: 'openai',    tier: 'smart',   toolUse: true  },
  { id: 'gpt-4o-mini',               label: 'GPT-4o Mini',              provider: 'openai',    tier: 'fast',    toolUse: true  },
  { id: 'gpt-4.1',                   label: 'GPT-4.1',                  provider: 'github',    tier: 'smart',   toolUse: true  },
  { id: 'gpt-4.1-mini',              label: 'GPT-4.1 Mini',             provider: 'github',    tier: 'fast',    toolUse: true  },
  { id: 'o4-mini',                   label: 'o4-mini (reasoning)',      provider: 'github',    tier: 'reason',  toolUse: false },
  { id: 'o3-mini',                   label: 'o3-mini (reasoning)',      provider: 'github',    tier: 'reason',  toolUse: false },
  // Anthropic Claude
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet',       provider: 'anthropic', tier: 'smart',   toolUse: true  },
  { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku',        provider: 'anthropic', tier: 'fast',    toolUse: true  },
  { id: 'claude-opus-4-5',            label: 'Claude Opus 4.5',         provider: 'anthropic', tier: 'smart',   toolUse: true  },
  // Groq (fast open-source)
  { id: 'llama-3.3-70b-versatile',   label: 'Llama 3.3 70B (Groq)',    provider: 'groq',      tier: 'fast',    toolUse: true  },
  { id: 'llama-3.1-8b-instant',      label: 'Llama 3.1 8B (Groq)',     provider: 'groq',      tier: 'fast',    toolUse: false },
  { id: 'mixtral-8x7b-32768',        label: 'Mixtral 8x7B (Groq)',     provider: 'groq',      tier: 'fast',    toolUse: false },
  { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 (Groq)', provider: 'groq',      tier: 'reason',  toolUse: false },
  // OpenRouter (cloud gateway — 200+ models)
  { id: 'openai/gpt-4o',                  label: 'GPT-4o (OpenRouter)',          provider: 'openrouter', tier: 'smart',  toolUse: false },
  { id: 'anthropic/claude-3.5-sonnet',    label: 'Claude 3.5 Sonnet (OR)',        provider: 'openrouter', tier: 'smart',  toolUse: false },
  { id: 'google/gemini-2.5-flash',        label: 'Gemini 2.5 Flash (OR)',         provider: 'openrouter', tier: 'fast',   toolUse: false },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OR)',        provider: 'openrouter', tier: 'fast',   toolUse: false },
  { id: 'deepseek/deepseek-r1',           label: 'DeepSeek R1 (OR)',              provider: 'openrouter', tier: 'reason', toolUse: false },
  { id: 'mistralai/mistral-large',        label: 'Mistral Large (OR)',            provider: 'openrouter', tier: 'smart',  toolUse: false },
  { id: 'qwen/qwen-2.5-72b-instruct',     label: 'Qwen 2.5 72B (OR)',            provider: 'openrouter', tier: 'fast',   toolUse: false },
  // HuggingFace Inference API (open-weights — local-capable)
  { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct',     label: 'Llama 3.1 70B (HF)',      provider: 'huggingface', tier: 'smart',  toolUse: false },
  { id: 'meta-llama/Llama-3.2-11B-Vision-Instruct',   label: 'Llama 3.2 11B Vision (HF)', provider: 'huggingface', tier: 'fast', toolUse: false },
  { id: 'mistralai/Mistral-7B-Instruct-v0.3',         label: 'Mistral 7B (HF)',          provider: 'huggingface', tier: 'fast',   toolUse: false },
  { id: 'Qwen/Qwen2.5-72B-Instruct',                  label: 'Qwen 2.5 72B (HF)',        provider: 'huggingface', tier: 'smart',  toolUse: false },
  { id: 'microsoft/Phi-3.5-mini-instruct',             label: 'Phi-3.5 Mini (HF)',        provider: 'huggingface', tier: 'fast',   toolUse: false },
] as const;

type ModelEntry = typeof SUPPORTED_MODELS[number];
type Provider = ModelEntry['provider'];

function getModelMeta(rawId: string): ModelEntry {
  // Strip provider prefixes the frontend may attach
  let modelId = rawId;
  let forceProvider: Provider | null = null;
  if (rawId.startsWith('gh:'))  { modelId = rawId.slice(3);  forceProvider = 'github'; }
  if (rawId.startsWith('or:'))  { modelId = rawId.slice(3);  forceProvider = 'openrouter'; }
  if (rawId.startsWith('hf:'))  { modelId = rawId.slice(3);  forceProvider = 'huggingface'; }
  if (rawId.startsWith('ant:')) { modelId = rawId.slice(4);  forceProvider = 'anthropic'; }
  if (rawId.startsWith('gr:'))  { modelId = rawId.slice(3);  forceProvider = 'groq'; }

  const found = SUPPORTED_MODELS.find(m => m.id === modelId) as ModelEntry | undefined;
  if (found) return forceProvider ? { ...found, provider: forceProvider } : found;

  // Unknown model — infer provider from name patterns
  const inferredProvider: Provider =
    forceProvider ??
    (modelId.startsWith('gemini')  ? 'gemini'    :
     modelId.startsWith('claude')  ? 'anthropic' :
     modelId.startsWith('llama') || modelId.startsWith('mixtral') || modelId.startsWith('deepseek') ? 'groq' :
     modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4') ? 'github' :
     modelId.includes('/') && !modelId.startsWith('gemini') ? 'openrouter' :
     'gemini');

  return { id: modelId, label: modelId, provider: inferredProvider, tier: 'fast', toolUse: inferredProvider !== 'groq' };
}

// ── Tool Schema Registry ─────────────────────────────────────────────────────
interface ToolSchema {
  name: string;
  description: string;
  params: Record<string, { type: string }>;
  required: string[];
  category: 'github' | 'mcp' | 'supabase' | 'vercel' | 'cli';
}

const TOOL_REGISTRY: ToolSchema[] = [
  { name: 'list_github_directory', description: 'List files/folders in a GitHub repo directory. Call first to explore structure.', params: { repo:{type:'string'}, path:{type:'string'} }, required: ['repo'], category: 'github' },
  { name: 'read_github_file',      description: 'Read full file content + SHA. ALWAYS call this before write_github_file to get the SHA.', params: { repo:{type:'string'}, path:{type:'string'}, ref:{type:'string'} }, required: ['repo','path'], category: 'github' },
  { name: 'write_github_file',     description: 'Create or update a file. REQUIRES sha param for existing files (get it from read_github_file first).', params: { repo:{type:'string'}, path:{type:'string'}, content:{type:'string'}, message:{type:'string'}, sha:{type:'string'}, branch:{type:'string'} }, required: ['repo','path','content','message'], category: 'github' },
  { name: 'delete_github_file',    description: 'Delete a file from a GitHub repo.', params: { repo:{type:'string'}, path:{type:'string'}, message:{type:'string'}, sha:{type:'string'} }, required: ['repo','path','message','sha'], category: 'github' },
  { name: 'search_github_code',    description: 'Search code across a GitHub repo.', params: { query:{type:'string'}, repo:{type:'string'} }, required: ['query'], category: 'github' },
  { name: 'create_github_branch',  description: 'Create a new branch in a GitHub repo.', params: { repo:{type:'string'}, branch:{type:'string'}, from_branch:{type:'string'} }, required: ['repo','branch'], category: 'github' },
  { name: 'create_github_pr',      description: 'Create a pull request.', params: { repo:{type:'string'}, title:{type:'string'}, head:{type:'string'}, base:{type:'string'}, body:{type:'string'} }, required: ['repo','title','head','base'], category: 'github' },
  { name: 'mcp_fetch_url',  description: 'Fetch a URL as clean text.', params: { url:{type:'string'}, max_length:{type:'string'} }, required: ['url'], category: 'mcp' },
  { name: 'mcp_remember',   description: 'Store a key/value in memory.', params: { key:{type:'string'}, value:{type:'string'} }, required: ['key','value'], category: 'mcp' },
  { name: 'mcp_recall',     description: 'Retrieve a stored memory by key.', params: { key:{type:'string'} }, required: ['key'], category: 'mcp' },
  { name: 'execute_supabase_sql', description: 'Execute a SQL query on the connected Supabase project.', params: { sql:{type:'string'}, project_ref:{type:'string'} }, required: ['sql'], category: 'supabase' },
  { name: 'list_supabase_tables', description: 'List all tables in the connected Supabase project.', params: { project_ref:{type:'string'} }, required: [], category: 'supabase' },
  { name: 'list_vercel_projects',    description: 'List Vercel projects for the connected account.', params: {}, required: [], category: 'vercel' },
  { name: 'get_vercel_deployments',  description: 'Get recent deployments for a Vercel project.', params: { project_id:{type:'string'} }, required: ['project_id'], category: 'vercel' },
  { name: 'trigger_vercel_redeploy', description: 'Trigger a redeployment of a Vercel project.', params: { deployment_id:{type:'string'} }, required: ['deployment_id'], category: 'vercel' },
  { name: 'run_cli_command', description: 'Run a safe shell command (git, npm, node, npx). No sudo/rm -rf.', params: { command:{type:'string'} }, required: ['command'], category: 'cli' },
];

// ── Tool format builders ─────────────────────────────────────────────────────

function buildGeminiTools(allowedCategories: string[]): object[] {
  const filtered = allowedCategories.length > 0
    ? TOOL_REGISTRY.filter(t => allowedCategories.includes(t.category))
    : TOOL_REGISTRY;
  return [{
    functionDeclarations: filtered.map(tool => ({
      name:        tool.name,
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

function buildOpenAITools(allowedCategories: string[]): object[] {
  const filtered = allowedCategories.length > 0
    ? TOOL_REGISTRY.filter(t => allowedCategories.includes(t.category))
    : TOOL_REGISTRY;
  return filtered.map(tool => ({
    type: 'function',
    function: {
      name:        tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.params).map(([k, v]) => [k, { type: v.type, description: k }]),
        ),
        required: tool.required,
      },
    },
  }));
}

function buildAnthropicTools(allowedCategories: string[]): object[] {
  const filtered = allowedCategories.length > 0
    ? TOOL_REGISTRY.filter(t => allowedCategories.includes(t.category))
    : TOOL_REGISTRY;
  return filtered.map(tool => ({
    name:        tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.params).map(([k, v]) => [k, { type: v.type, description: k }]),
      ),
      required: tool.required,
    },
  }));
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

// ── GET handler — model list ──────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ models: SUPPORTED_MODELS });
}

// ── Main POST handler ─────────────────────────────────────────────────────────
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

  let requestBody: Record<string, unknown>;
  try {
    requestBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── Backward-compatible messages parsing ─────────────────────────────────
  // Accepts:
  //   { messages: [{ role, content }] }  — standard array format
  //   { message: "string" }              — legacy single-message format
  //   { prompt: "string" }               — legacy prompt format
  const messages: { role: string; content: string }[] =
    Array.isArray(requestBody.messages)
      ? (requestBody.messages as { role: string; content: string }[]).filter(m => m?.role && m?.content)
      : typeof requestBody.message === 'string' && requestBody.message.trim()
        ? [{ role: 'user', content: requestBody.message as string }]
        : typeof requestBody.prompt === 'string' && requestBody.prompt.trim()
          ? [{ role: 'user', content: requestBody.prompt as string }]
          : [];

  if (!messages.length) {
    return NextResponse.json(
      { error: 'messages array is required — send { messages: [{ role: "user", content: "..." }] } or { message: "..." }' },
      { status: 400 },
    );
  }

  const sessionId  = (requestBody.sessionId  as string | undefined) ?? `anon_${Date.now()}`;
  const settings   = (requestBody.settings   as Record<string, string | boolean> | undefined) ?? {};
  const existingStateId = requestBody.stateId as string | undefined;
  const userReply       = requestBody.userReply as string | undefined;

  // ── Resolve keys & model ─────────────────────────────────────────────────
  const geminiKey    = (settings.custom_gemini_api_key  as string | undefined) || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_KEY || '';
  const openaiKey    = (settings.openai_api_key         as string | undefined) || process.env.OPENAI_API_KEY || '';
  const anthropicKey = (settings.anthropic_api_key      as string | undefined) || process.env.ANTHROPIC_API_KEY || '';
  const groqKey        = (settings.groq_api_key           as string | undefined) || process.env.GROQ_API_KEY || '';
  const openrouterKey  = (settings.openrouter_api_key     as string | undefined) || process.env.OPENROUTER_API_KEY || '';
  const hfToken        = (settings.hf_token               as string | undefined) || process.env.HF_TOKEN || '';
  const githubToken  = (settings.github_token           as string | undefined) || process.env.GITHUB_TOKEN || '';

  const rawModelName = (settings.active_model_name as string | undefined) || (settings.model as string | undefined) || 'gemini-2.5-flash';
  const modelMeta    = getModelMeta(rawModelName);

  // ── Build / restore execution state ─────────────────────────────────────
  const userGoal = messages.find(m => m.role === 'user')?.content ?? 'No goal specified';
  let execState = existingStateId
    ? await import('@/lib/agentState').then(m => m.loadState(existingStateId)).then(s => s ?? createState(sessionId, userGoal))
    : createState(sessionId, userGoal);

  if (userReply && existingStateId) {
    await import('@/lib/agentState').then(m => m.resolveHumanRequest(existingStateId, userReply));
    execState = await import('@/lib/agentState').then(m =>
      m.updateState(execState.stateId, {
        activeRole:   'coder',
        pendingTasks: [...execState.pendingTasks, `User replied: ${userReply}`],
      }).then(s => s ?? execState),
    );
  }

  // ── Supervisor routing ────────────────────────────────────────────────────
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

  // ── Load workspace skills ─────────────────────────────────────────────────
  const contextText  = `${userGoal} ${executionCtx.currentStep}`;
  const activeSkills = await selectActiveSkills(sessionId, contextText);
  const skillsBlock  = buildSkillsBlock(activeSkills);

  // ── Build system prompt ───────────────────────────────────────────────────
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

  // Inject GitHub context so agent knows the user's repos
  const ghContext = settings.github_context as Record<string,unknown> | undefined;
  const githubCtxBlock = ghContext?.repos
    ? `\n\n── GitHub Account: ${settings.github_username ?? 'unknown'} ──\nRepositories (${(ghContext.repos as unknown[]).length}): ${(ghContext.repos as Array<{name:string;description:string|null;language:string|null;private:boolean}>).map(r => `${r.private?'🔒':'📦'} ${r.name}${r.language ? ` [${r.language}]` : ''}${r.description ? ` — ${r.description}` : ''}`).join(', ')}`
    : '';
  const systemPromptWithCtx = systemPrompt + githubCtxBlock;

  // ── Agent role → allowed tool categories ─────────────────────────────────
  const roleCategories: Record<string, string[]> = {
    architect:  ['github', 'mcp', 'cli'],
    coder:      ['github', 'mcp', 'cli', 'supabase'],
    debugger:   ['github', 'mcp', 'cli'],
    tester:     ['github', 'cli'],
    deployer:   ['vercel', 'supabase', 'github', 'cli'],
    researcher: ['mcp', 'cli'],
    supervisor: [],
  };
  const allowedCategories = roleCategories[activeRole] ?? [];

  // Token estimate
  _estimatedTokens = Math.floor(
    systemPrompt.length / 4 +
    messages.reduce((s, m) => s + (m.content?.length ?? 0) / 4, 0),
  );

  // ── Streaming response ────────────────────────────────────────────────────
  const encoder  = new TextEncoder();
  const toolCallLog: { name: string; args: Record<string, unknown>; result?: string }[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      try {
        send(`data: ${JSON.stringify({
          type: 'routing',
          role: activeRole,
          model: modelMeta.id,
          provider: modelMeta.provider,
          confidence: routingDecision.confidence,
          reasoning: routingDecision.reasoning,
          activeSkills: activeSkills.map(s => s.name),
        })}\n\n`);

        // ── Dispatch to the right provider loop ──────────────────────────
        if (modelMeta.provider === 'gemini') {
          await runGeminiLoop({
            send, messages, systemPrompt: systemPromptWithCtx, modelName: modelMeta.id,
            geminiKey, githubToken, allowedCategories,
            execState, sessionId, activeRole, activeSkills, toolCallLog,
          });
        } else if (modelMeta.provider === 'anthropic') {
          await runAnthropicLoop({
            send, messages, systemPrompt: systemPromptWithCtx, modelName: modelMeta.id,
            anthropicKey, allowedCategories,
            execState, sessionId, activeRole, activeSkills, toolCallLog,
          });
        } else {
          // openai / github / groq — all OpenAI-compatible
          await runOpenAICompatLoop({
            send, messages, systemPrompt: systemPromptWithCtx, modelMeta,
            openaiKey, githubToken, groqKey, openrouterKey, hfToken, allowedCategories,
            execState, sessionId, activeRole, activeSkills, toolCallLog,
          });
        }

        // Persist final state
        await updateState(execState.stateId, {
          activeRole,
          activeSkills: activeSkills.map(s => s.name),
          stepIndex:    execState.stepIndex + 1,
        });

        send(`data: ${JSON.stringify({
          type: 'done',
          text: _lastText || undefined,
          model: modelMeta.id,
          provider: modelMeta.provider,
          role: activeRole,
          toolCallCount: toolCallLog.length,
          estimatedTokens: _estimatedTokens,
          stateId: execState.stateId,
        })}\n\n`);

      } catch (outerErr: unknown) {
        const msg = outerErr instanceof Error ? outerErr.message : 'Internal error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', content: msg })}\n\n`));
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

// ═══════════════════════════════════════════════════════════════════════════════
// Provider loops
// ═══════════════════════════════════════════════════════════════════════════════

interface LoopCtx {
  send: (s: string) => void;
  messages: { role: string; content: string }[];
  systemPrompt: string;
  allowedCategories: string[];
  execState: ReturnType<typeof createState>;
  sessionId: string;
  activeRole: string;
  activeSkills: Awaited<ReturnType<typeof selectActiveSkills>>;
  toolCallLog: { name: string; args: Record<string, unknown>; result?: string }[];
}

// Persist tool calls to agent_messages so they survive the session
async function saveToolCallsToDb(
  sessionId: string,
  toolCallLog: { name: string; args: Record<string, unknown>; result?: string }[],
  model: string,
  role: string,
): Promise<void> {
  if (!toolCallLog.length) return;
  try {
    const { getSupabase } = await import('@/lib/supabase');
    const sb = getSupabase();
    await sb.from('agent_messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: `[Tool calls: ${toolCallLog.map(t => t.name).join(', ')}]`,
      tool_calls: JSON.stringify(toolCallLog),
      model,
      agent_role: role,
    });
  } catch (e) {
    console.warn('saveToolCallsToDb error:', e instanceof Error ? e.message : e);
  }
}

// ── Gemini loop ───────────────────────────────────────────────────────────────
async function runGeminiLoop(ctx: LoopCtx & { modelName: string; geminiKey: string; githubToken: string }) {
  const { send, messages, systemPrompt, modelName, geminiKey, githubToken, allowedCategories, execState, toolCallLog } = ctx;
  const tools = buildGeminiTools(allowedCategories);
  let conversationMessages = buildContents(messages);
  let turns = 0;

  while (turns < MAX_TURNS && _estimatedTokens < MAX_COST_TOKENS) {
    turns++;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;
    let geminiRes: Response;
    try {
      geminiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: conversationMessages,
          tools,
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      send(`data: ${JSON.stringify({ type: 'error', content: `Gemini connection failed: ${e instanceof Error ? e.message : 'network'}` })}\n\n`);
      break;
    }

    if (!geminiRes.ok) {
      // Fallback to GitHub Models gpt-4o-mini
      const fallback = await tryGithubModelsFallback(systemPrompt, messages, githubToken);
      if (fallback) {
        send(`data: ${JSON.stringify({ type: 'text', text: fallback })}\n\n`);
      } else {
        const errText = await geminiRes.text().catch(() => '');
        send(`data: ${JSON.stringify({ type: 'error', content: `Gemini ${geminiRes.status}: ${errText.slice(0, 200)}` })}\n\n`);
      }
      break;
    }

    const geminiData = await geminiRes.json();
    if (geminiData.usageMetadata) _estimatedTokens = geminiData.usageMetadata.totalTokenCount ?? _estimatedTokens;

    const candidate = geminiData.candidates?.[0];
    if (!candidate) {
      if (turns === 1) { conversationMessages.push({ role: 'user', parts: [{ text: 'Please respond.' }] } as never); continue; }
      send(`data: ${JSON.stringify({ type: 'error', content: 'No response from Gemini. Try switching models.' })}\n\n`);
      break;
    }

    const parts        = candidate.content?.parts ?? [];
    let textThisTurn   = '';
    const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for (const part of parts) {
      if (part.text)         textThisTurn += part.text;
      if (part.functionCall) functionCalls.push(part.functionCall);
    }

    if (textThisTurn) {
      const escalation = extractEscalation(textThisTurn);
      if (escalation) {
        await updateState(execState.stateId, { errorLog: [...execState.errorLog, escalation] });
        const askReq = await pauseForHuman(execState, escalation);
        send(`data: ${JSON.stringify({ type: 'ask_human', stateId: askReq.stateId, resumeStep: askReq.resumeStep, reason: escalation, errorLog: execState.errorLog })}\n\n`);
        break;
      }
      for (const chunk of textThisTurn.split(/(?<=\n)/)) {
        send(`data: ${JSON.stringify({ type: 'text', text: chunk })}\n\n`); _lastText += chunk;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (!textThisTurn && !functionCalls.length) {
      conversationMessages.push({ role: 'user', parts: [{ text: SUMMARY_PROMPT }] } as never);
      send(`data: ${JSON.stringify({ type: 'system', content: '[Auto-requesting summary]' })}\n\n`);
      continue;
    }
    if (!functionCalls.length) break;

    conversationMessages.push({ role: 'model', parts } as never);
    const toolResults: object[] = [];

    for (const call of functionCalls) {
      send(`data: ${JSON.stringify({ type: 'tool_start', tool: call.name, args: call.args })}\n\n`);
      let result = '';
      try {
        result = await executeTool(call.name, call.args, { githubToken, sessionId: ctx.sessionId });
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
        execState.errorLog.push(`${call.name}: ${result}`);
        await updateState(execState.stateId, { errorLog: execState.errorLog });
      }
      toolCallLog.push({ name: call.name, args: call.args, result });
      send(`data: ${JSON.stringify({ type: 'tool_result', tool: call.name, result: result.slice(0, 500) })}\n\n`);
      toolResults.push({ functionResponse: { name: call.name, response: { content: result } } });
    }
    await saveToolCallsToDb(ctx.sessionId, toolCallLog, ctx.modelName, ctx.activeRole);
    conversationMessages.push({ role: 'user', parts: toolResults } as never);
  }

  if (turns >= MAX_TURNS)     send(`data: ${JSON.stringify({ type: 'system', content: `[Circuit breaker: ${MAX_TURNS} turns]` })}\n\n`);
  if (_estimatedTokens >= MAX_COST_TOKENS) send(`data: ${JSON.stringify({ type: 'system', content: `[Token budget exhausted: ${_estimatedTokens}]` })}\n\n`);
}

// ── OpenAI-compatible loop (OpenAI / GitHub Models / Groq) ────────────────────
async function runOpenAICompatLoop(ctx: LoopCtx & {
  modelMeta: ModelEntry; openaiKey: string; githubToken: string; groqKey: string;
  openrouterKey: string; hfToken: string;
}) {
  const { send, messages, systemPrompt, modelMeta, openaiKey, githubToken, groqKey, openrouterKey, hfToken, allowedCategories, execState, toolCallLog } = ctx;

  // Determine base URL + key
  let baseUrl: string;
  let apiKey: string;

  if (modelMeta.provider === 'github') {
    baseUrl = 'https://models.github.ai/inference';
    apiKey  = githubToken;
  } else if (modelMeta.provider === 'groq') {
    baseUrl = 'https://api.groq.com/openai/v1';
    apiKey  = groqKey;
  } else if (modelMeta.provider === 'openrouter') {
    baseUrl = 'https://openrouter.ai/api/v1';
    apiKey  = openrouterKey;
  } else if (modelMeta.provider === 'huggingface') {
    baseUrl = 'https://api-inference.huggingface.co/v1';
    apiKey  = hfToken;
  } else {
    // openai
    baseUrl = 'https://api.openai.com/v1';
    apiKey  = openaiKey || githubToken; // fallback to github token for preview access
  }

  if (!apiKey) {
    send(`data: ${JSON.stringify({ type: 'error', content: `No API key configured for provider ${modelMeta.provider}. Set the appropriate key in settings or environment variables.` })}\n\n`);
    return;
  }

  const tools = modelMeta.toolUse ? buildOpenAITools(allowedCategories) : undefined;
  const convMessages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string }[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  let turns = 0;
  while (turns < MAX_TURNS && _estimatedTokens < MAX_COST_TOKENS) {
    turns++;

    const body: Record<string, unknown> = {
      model:       modelMeta.id,
      messages:    convMessages,
      max_tokens:  8192,
      temperature: modelMeta.tier === 'reason' ? 1 : 0.7,
    };
    if (tools?.length) body.tools = tools;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(60_000),
      });
    } catch (e) {
      send(`data: ${JSON.stringify({ type: 'error', content: `${modelMeta.provider} connection failed: ${e instanceof Error ? e.message : 'network'}` })}\n\n`);
      break;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      send(`data: ${JSON.stringify({ type: 'error', content: `${modelMeta.provider} ${res.status}: ${errText.slice(0, 300)}` })}\n\n`);
      break;
    }

    const data = await res.json();
    if (data.usage?.total_tokens) _estimatedTokens = data.usage.total_tokens;

    const choice  = data.choices?.[0];
    const msg     = choice?.message;
    if (!msg) {
      // Retry once with a nudge before giving up
      if (turns === 1) {
        convMessages.push({ role: 'user', content: 'Please respond to the last message.' });
        continue;
      }
      send(`data: ${JSON.stringify({ type: 'error', content: 'No response from model. Try a different model or rephrase your request.' })}\n\n`);
      break;
    }

    // Text content
    if (msg.content) {
      const escalation = extractEscalation(msg.content);
      if (escalation) {
        await updateState(execState.stateId, { errorLog: [...execState.errorLog, escalation] });
        const askReq = await pauseForHuman(execState, escalation);
        send(`data: ${JSON.stringify({ type: 'ask_human', stateId: askReq.stateId, resumeStep: askReq.resumeStep, reason: escalation, errorLog: execState.errorLog })}\n\n`);
        break;
      }
      for (const chunk of msg.content.split(/(?<=\n)/)) {
        send(`data: ${JSON.stringify({ type: 'text', text: chunk })}\n\n`); _lastText += chunk;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Tool calls
    if (!msg.tool_calls?.length) break;

    convMessages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const callName = tc.function?.name ?? '';
      let callArgs: Record<string, unknown> = {};
      try { callArgs = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /* noop */ }

      send(`data: ${JSON.stringify({ type: 'tool_start', tool: callName, args: callArgs })}\n\n`);
      let result = '';
      try {
        result = await executeTool(callName, callArgs, { githubToken, sessionId: ctx.sessionId });
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      toolCallLog.push({ name: callName, args: callArgs, result });
      send(`data: ${JSON.stringify({ type: 'tool_result', tool: callName, result: result.slice(0, 500) })}\n\n`);
      convMessages.push({ role: 'tool', tool_call_id: tc.id, name: callName, content: result });
    }
  }
  // Persist tool calls to DB after loop completes
  await saveToolCallsToDb(ctx.sessionId, toolCallLog, modelMeta.id, ctx.activeRole);
}

// ── Anthropic Claude loop ─────────────────────────────────────────────────────
async function runAnthropicLoop(ctx: LoopCtx & { modelName: string; anthropicKey: string }) {
  const { send, messages, systemPrompt, modelName, anthropicKey, allowedCategories, execState, toolCallLog } = ctx;

  if (!anthropicKey) {
    send(`data: ${JSON.stringify({ type: 'error', content: 'No ANTHROPIC_API_KEY configured. Add it to Vercel env vars or pass anthropic_api_key in settings.' })}\n\n`);
    return;
  }

  const tools = buildAnthropicTools(allowedCategories);
  const convMessages = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  let turns = 0;

  while (turns < MAX_TURNS && _estimatedTokens < MAX_COST_TOKENS) {
    turns++;

    const body: Record<string, unknown> = {
      model:      modelName,
      max_tokens: 8192,
      system:     systemPrompt,
      messages:   convMessages,
    };
    if (tools.length) body.tools = tools;

    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      send(`data: ${JSON.stringify({ type: 'error', content: `Anthropic connection failed: ${e instanceof Error ? e.message : 'network'}` })}\n\n`);
      break;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      send(`data: ${JSON.stringify({ type: 'error', content: `Anthropic ${res.status}: ${errText.slice(0, 300)}` })}\n\n`);
      break;
    }

    const data = await res.json();
    if (data.usage?.input_tokens) _estimatedTokens += (data.usage.input_tokens + (data.usage.output_tokens ?? 0));

    const blocks    = data.content ?? [];
    let textOutput  = '';
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of blocks) {
      if (block.type === 'text')     textOutput += block.text;
      if (block.type === 'tool_use') toolUseBlocks.push(block);
    }

    if (textOutput) {
      const escalation = extractEscalation(textOutput);
      if (escalation) {
        await updateState(execState.stateId, { errorLog: [...execState.errorLog, escalation] });
        const askReq = await pauseForHuman(execState, escalation);
        send(`data: ${JSON.stringify({ type: 'ask_human', stateId: askReq.stateId, resumeStep: askReq.resumeStep, reason: escalation })}\n\n`);
        break;
      }
      for (const chunk of textOutput.split(/(?<=\n)/)) {
        send(`data: ${JSON.stringify({ type: 'text', text: chunk })}\n\n`); _lastText += chunk;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (!toolUseBlocks.length) break;

    convMessages.push({ role: 'assistant', content: blocks });
    const toolResults = [];

    for (const tu of toolUseBlocks) {
      send(`data: ${JSON.stringify({ type: 'tool_start', tool: tu.name, args: tu.input })}\n\n`);
      let result = '';
      try {
        result = await executeTool(tu.name, tu.input, { githubToken: ctx.sessionId, sessionId: ctx.sessionId });
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      toolCallLog.push({ name: tu.name, args: tu.input, result });
      send(`data: ${JSON.stringify({ type: 'tool_result', tool: tu.name, result: result.slice(0, 500) })}\n\n`);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    convMessages.push({ role: 'user', content: toolResults });
  }
}

// ── GitHub Models fallback (used when Gemini is down) ────────────────────────
async function tryGithubModelsFallback(system: string, messages: { role: string; content: string }[], token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const res = await fetch('https://models.github.ai/inference/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model:    'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Executor
// ═══════════════════════════════════════════════════════════════════════════════
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { githubToken: string; sessionId: string },
): Promise<string> {
  const { githubToken, sessionId } = ctx;

  if (name === 'list_github_directory') {
    const res = await githubApiCall(`/repos/${String(args.repo ?? '')}/contents/${String(args.path ?? '')}`, githubToken);
    if (!res.ok) return `GitHub error: ${res.status}`;
    const data = await res.json();
    if (Array.isArray(data)) return data.map((f: { name: string; type: string; size: number }) => `${f.type === 'dir' ? '📁' : '📄'} ${f.name} (${f.type}${f.type === 'file' ? `, ${f.size}B` : ''})`).join('\n');
    return JSON.stringify(data).slice(0, 2000);
  }

  if (name === 'read_github_file') {
    const res = await githubApiCall(`/repos/${String(args.repo)}/contents/${String(args.path)}${args.ref ? `?ref=${args.ref}` : ''}`, githubToken);
    if (!res.ok) return `GitHub error: ${res.status} - ${await res.text()}`;
    const data = await res.json();
    const content = data.content ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8') : '';
    return `SHA: ${data.sha}\n\n${content.slice(0, 20000)}`;
  }

  if (name === 'write_github_file') {
    const body: Record<string, string> = {
      message: String(args.message ?? 'Update via AI agent'),
      content: Buffer.from(String(args.content ?? '')).toString('base64'),
    };
    if (args.sha)    body.sha    = String(args.sha);
    if (args.branch) body.branch = String(args.branch);
    const res  = await githubApiCall(`/repos/${String(args.repo)}/contents/${String(args.path)}`, githubToken, 'PUT', body);
    const data = await res.json();
    if (!res.ok) return `GitHub write error: ${res.status} — ${data.message ?? JSON.stringify(data)}`;
    return `✅ File written: ${data.content?.html_url ?? String(args.path)}`;
  }

  if (name === 'delete_github_file') {
    const res = await githubApiCall(`/repos/${String(args.repo)}/contents/${String(args.path)}`, githubToken, 'DELETE', { message: String(args.message ?? 'Delete via AI agent'), sha: String(args.sha ?? '') });
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
    const fromBranch = String(args.from_branch ?? 'main');
    const refRes = await githubApiCall(`/repos/${String(args.repo)}/git/ref/heads/${fromBranch}`, githubToken);
    if (!refRes.ok) return `Could not get ref: ${refRes.status}`;
    const refData = await refRes.json();
    const sha = refData.object?.sha;
    const res = await githubApiCall(`/repos/${String(args.repo)}/git/refs`, githubToken, 'POST', { ref: `refs/heads/${String(args.branch)}`, sha });
    return res.ok ? `✅ Branch '${String(args.branch)}' created from '${fromBranch}'` : `Branch error: ${res.status}`;
  }

  if (name === 'create_github_pr') {
    const res  = await githubApiCall(`/repos/${String(args.repo)}/pulls`, githubToken, 'POST', { title: String(args.title ?? 'AI Agent PR'), head: String(args.head), base: String(args.base ?? 'main'), body: String(args.body ?? '') });
    const data = await res.json();
    return res.ok ? `✅ PR created: ${data.html_url}` : `PR error: ${res.status} — ${data.message}`;
  }

  if (name === 'mcp_fetch_url') {
    const mcpRes = await fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'mcp_fetch_url', arguments: args }), signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    const data = await mcpRes.json();
    return data.result ?? data.error ?? 'No result';
  }

  if (name === 'mcp_remember') { _agentMemory[String(args.key)] = String(args.value); return `Remembered: ${String(args.key)}`; }
  if (name === 'mcp_recall')   { const val = _agentMemory[String(args.key)]; return val !== undefined ? val : `No memory for key: ${String(args.key)}`; }

  if (name === 'run_cli_command') {
    const cmd = String(args.command ?? '');
    const BLOCKED = ['rm -rf', 'sudo', 'chmod 777', 'curl | sh', 'wget | sh', '> /dev/'];
    if (BLOCKED.some(b => cmd.includes(b))) return `❌ Blocked: dangerous command pattern`;
    const ALLOWED_PREFIXES = ['git ', 'npm ', 'npx ', 'node ', 'ls ', 'cat ', 'echo ', 'pwd', 'find ', 'grep ', 'wc '];
    if (!ALLOWED_PREFIXES.some(p => cmd.startsWith(p))) return `❌ Blocked: only git/npm/npx/node/ls/cat commands are allowed`;
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: TOOL_TIMEOUT_MS });
      return (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).slice(0, 5000);
    } catch (e) {
      const err = e as { message: string; stderr?: string };
      return `Command failed: ${err.message}\n${err.stderr ?? ''}`.slice(0, 2000);
    }
  }

  if (name === 'execute_supabase_sql' || name === 'list_supabase_tables') {
    const sbRes = await fetch('/api/supabase/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, ...args }), signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    const data = await sbRes.json();
    return JSON.stringify(data).slice(0, 3000);
  }

  if (name.startsWith('list_vercel') || name.startsWith('get_vercel') || name.startsWith('trigger_vercel')) {
    const vcRes = await fetch('/api/vercel/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, ...args }), signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    const data = await vcRes.json();
    return JSON.stringify(data).slice(0, 3000);
  }

  return `Unknown tool: ${name}`;
}

// ── GitHub API helper ─────────────────────────────────────────────────────────
function githubApiCall(path: string, token: string, method = 'GET', body?: object): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MonicaAgentStudio/2.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body)  headers['Content-Type']  = 'application/json';
  return fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
}
