/**
 * web/app/api/chat/route.ts
 * Jarvis — Multi-Provider Streaming Chat
 * Providers: Gemini · OpenAI · Anthropic · Groq · OpenRouter · HuggingFace
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';
export const maxDuration = 60;

// ── Model registry ─────────────────────────────────────────────────────────
export const MODELS = [
  // ☁ Cloud — Gemini
  { id: 'gemini-2.5-flash',                            label: '☁ Gemini 2.5 Flash',          provider: 'gemini',      cloud: true  },
  { id: 'gemini-2.5-pro',                              label: '☁ Gemini 2.5 Pro',            provider: 'gemini',      cloud: true  },
  { id: 'gemini-2.0-flash',                            label: '☁ Gemini 2.0 Flash',          provider: 'gemini',      cloud: true  },
  { id: 'gemini-1.5-pro',                              label: '☁ Gemini 1.5 Pro',            provider: 'gemini',      cloud: true  },
  { id: 'gemini-1.5-flash',                            label: '☁ Gemini 1.5 Flash',          provider: 'gemini',      cloud: true  },
  // ☁ Cloud — Anthropic Claude
  { id: 'claude-3-5-sonnet-20241022',                  label: '☁ Claude 3.5 Sonnet',         provider: 'anthropic',   cloud: true  },
  { id: 'claude-3-5-haiku-20241022',                   label: '☁ Claude 3.5 Haiku',          provider: 'anthropic',   cloud: true  },
  { id: 'claude-opus-4-5',                             label: '☁ Claude Opus 4.5',           provider: 'anthropic',   cloud: true  },
  // ☁ Cloud — OpenAI
  { id: 'gpt-4o',                                      label: '☁ GPT-4o',                    provider: 'openai',      cloud: true  },
  { id: 'gpt-4o-mini',                                 label: '☁ GPT-4o Mini',               provider: 'openai',      cloud: true  },
  { id: 'o4-mini',                                     label: '☁ o4-mini (reasoning)',        provider: 'openai',      cloud: true  },
  // ☁ Cloud — GitHub Models (free tier)
  { id: 'gh:gpt-4.1',                                  label: '☁ GPT-4.1 (GitHub)',          provider: 'github',      cloud: true  },
  { id: 'gh:gpt-4.1-mini',                             label: '☁ GPT-4.1 Mini (GitHub)',     provider: 'github',      cloud: true  },
  { id: 'gh:gpt-4.1-nano',                             label: '☁ GPT-4.1 Nano (GitHub)',     provider: 'github',      cloud: true  },
  // ☁ Cloud — Groq (fast inference)
  { id: 'llama-3.3-70b-versatile',                     label: '☁ Llama 3.3 70B (Groq)',      provider: 'groq',        cloud: true  },
  { id: 'llama-3.1-8b-instant',                        label: '☁ Llama 3.1 8B (Groq)',       provider: 'groq',        cloud: true  },
  { id: 'mixtral-8x7b-32768',                          label: '☁ Mixtral 8x7B (Groq)',       provider: 'groq',        cloud: true  },
  { id: 'deepseek-r1-distill-llama-70b',               label: '☁ DeepSeek R1 (Groq)',        provider: 'groq',        cloud: true  },
  // ☁ Cloud — OpenRouter (200+ models gateway)
  { id: 'openai/gpt-4o',                               label: '☁ GPT-4o (OpenRouter)',       provider: 'openrouter',  cloud: true  },
  { id: 'anthropic/claude-3.5-sonnet',                 label: '☁ Claude 3.5 (OpenRouter)',   provider: 'openrouter',  cloud: true  },
  { id: 'google/gemini-2.5-flash',                     label: '☁ Gemini 2.5 Flash (OR)',     provider: 'openrouter',  cloud: true  },
  { id: 'deepseek/deepseek-r1',                        label: '☁ DeepSeek R1 (OpenRouter)',  provider: 'openrouter',  cloud: true  },
  { id: 'meta-llama/llama-3.3-70b-instruct',           label: '☁ Llama 3.3 70B (OR)',        provider: 'openrouter',  cloud: true  },
  { id: 'mistralai/mistral-large',                     label: '☁ Mistral Large (OR)',        provider: 'openrouter',  cloud: true  },
  // 🖥 Local-capable — HuggingFace (run locally via Ollama or HF Inference API)
  { id: 'hf:meta-llama/Meta-Llama-3.1-70B-Instruct',  label: '🖥 Llama 3.1 70B (HF/Local)', provider: 'huggingface', cloud: false },
  { id: 'hf:mistralai/Mistral-7B-Instruct-v0.3',      label: '🖥 Mistral 7B (HF/Local)',    provider: 'huggingface', cloud: false },
  { id: 'hf:Qwen/Qwen2.5-72B-Instruct',               label: '🖥 Qwen 2.5 72B (HF/Local)',  provider: 'huggingface', cloud: false },
  { id: 'hf:microsoft/Phi-3.5-mini-instruct',         label: '🖥 Phi-3.5 Mini (HF/Local)',  provider: 'huggingface', cloud: false },
] as const;

type ModelEntry = (typeof MODELS)[number];
type Provider   = ModelEntry['provider'];

function resolveModel(rawId: string): { modelId: string; provider: Provider; label: string; cloud: boolean } {
  // Direct match first
  const direct = MODELS.find(m => m.id === rawId);
  if (direct) return { modelId: rawId.replace(/^(gh:|hf:|or:)/, ''), provider: direct.provider, label: direct.label, cloud: direct.cloud };

  // Strip prefix
  let modelId = rawId;
  let forceProvider: Provider | null = null;
  if (rawId.startsWith('gh:'))   { modelId = rawId.slice(3); forceProvider = 'github'; }
  else if (rawId.startsWith('hf:'))  { modelId = rawId.slice(3); forceProvider = 'huggingface'; }
  else if (rawId.startsWith('or:'))  { modelId = rawId.slice(3); forceProvider = 'openrouter'; }

  const stripped = MODELS.find(m => m.id.replace(/^(gh:|hf:|or:)/, '') === modelId);
  if (stripped) return { modelId, provider: forceProvider ?? stripped.provider, label: stripped.label, cloud: stripped.cloud };

  // Infer from name
  const inferProvider: Provider =
    forceProvider ??
    (modelId.startsWith('gemini')                      ? 'gemini'      :
     modelId.startsWith('claude')                      ? 'anthropic'   :
     modelId.startsWith('gpt') || modelId.startsWith('o4') || modelId.startsWith('o3') ? 'openai' :
     modelId.startsWith('llama') || modelId.startsWith('mixtral') || modelId.startsWith('deepseek-r1-distill') ? 'groq' :
     modelId.includes('/')                             ? 'openrouter'  :
     'gemini');

  return { modelId, provider: inferProvider, label: modelId, cloud: inferProvider !== 'huggingface' };
}

// ── GET — model list ────────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ models: MODELS });
}

// ── Simple rate limit (in-memory) ──────────────────────────────────────────
const _rl: Record<string, { count: number; reset: number }> = {};
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const w = (_rl[ip] ??= { count: 0, reset: now + 60_000 });
  if (now > w.reset) { w.count = 0; w.reset = now + 60_000; }
  w.count++;
  return w.count <= 30;
}

// ── POST — main chat handler ────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? '127.0.0.1').split(',')[0].trim();
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded. Try again in 60s.' }, { status: 429 });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // Backward-compatible message parsing
  const messages: { role: string; content: string }[] =
    Array.isArray(body.messages)
      ? (body.messages as { role: string; content: string }[]).filter(m => m?.role && m?.content)
      : typeof body.message === 'string' && body.message.trim()
        ? [{ role: 'user', content: body.message }]
        : typeof body.prompt === 'string' && body.prompt.trim()
          ? [{ role: 'user', content: body.prompt }]
          : [];

  if (!messages.length) {
    return NextResponse.json({ error: 'Send { messages: [{ role: "user", content: "..." }] } or { message: "..." }' }, { status: 400 });
  }

  const settings     = (body.settings as Record<string, unknown>) ?? {};
  const rawModelName = (settings.active_model_name as string) || (settings.model as string) || 'llama-3.3-70b-versatile';
  const { modelId, provider, label, cloud } = resolveModel(rawModelName);

  // Resolve API keys — settings override > env vars
  const keys = {
    gemini:      (settings.custom_gemini_api_key  as string) || process.env.GEMINI_API_KEY || '',
    openai:      (settings.openai_api_key         as string) || process.env.OPENAI_API_KEY || '',
    anthropic:   (settings.anthropic_api_key      as string) || process.env.ANTHROPIC_API_KEY || '',
    groq:        (settings.groq_api_key           as string) || process.env.GROQ_API_KEY || '',
    openrouter:  (settings.openrouter_api_key     as string) || process.env.OPENROUTER_API_KEY || '',
    hf:          (settings.hf_token               as string) || process.env.HF_TOKEN || '',
    github:      (settings.github_token           as string) || process.env.GITHUB_TOKEN || '',
  };

  // System prompt
  const systemPrompt = [
    'You are Jarvis, an advanced AI assistant. Be direct, helpful, and thorough.',
    'When writing code, use proper formatting and comments.',
    cloud ? `Running via ${label} (cloud model).` : `Running via ${label} (local/edge model).`,
  ].join('\n');

  // SSE stream
  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(data)); } catch { /* closed */ }
      };

      // Announce routing
      send(`data: ${JSON.stringify({ type: 'routing', model: modelId, provider, role: 'assistant', label })}\n\n`);

      try {
        let estimatedTokens = 0;

        if (provider === 'gemini') {
          // ── Gemini ────────────────────────────────────────────────────
          const key = keys.gemini;
          if (!key) throw new Error('GEMINI_API_KEY not configured');

          const contents = messages.filter(m => m.content?.trim()).map(m => ({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }));

          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?key=${key}&alt=sse`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents,
                generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
              }),
              signal: AbortSignal.timeout(55_000),
            },
          );

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
          }

          const reader = res.body?.getReader();
          const dec    = new TextDecoder();
          let buf = '';

          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              try {
                const chunk = JSON.parse(line.slice(5).trim());
                const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                if (text) send(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
                if (chunk.usageMetadata?.totalTokenCount) estimatedTokens = chunk.usageMetadata.totalTokenCount;
              } catch { /* partial JSON */ }
            }
          }

        } else if (provider === 'anthropic') {
          // ── Anthropic ─────────────────────────────────────────────────
          const key = keys.anthropic;
          if (!key) throw new Error('ANTHROPIC_API_KEY not configured');

          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'output-128k-2025-02-19',
            },
            body: JSON.stringify({
              model: modelId,
              max_tokens: 8192,
              system: systemPrompt,
              messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
              stream: true,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Anthropic ${res.status}: ${err.slice(0, 300)}`);
          }

          const reader = res.body?.getReader();
          const dec    = new TextDecoder();
          let buf = '';

          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              try {
                const ev = JSON.parse(line.slice(5).trim());
                if (ev.type === 'content_block_delta' && ev.delta?.text) {
                  send(`data: ${JSON.stringify({ type: 'text', text: ev.delta.text })}\n\n`);
                }
                if (ev.type === 'message_delta' && ev.usage?.output_tokens) {
                  estimatedTokens = (ev.usage.input_tokens ?? 0) + ev.usage.output_tokens;
                }
              } catch { /* partial */ }
            }
          }

        } else if (provider === 'groq') {
          // ── Groq ──────────────────────────────────────────────────────
          const key = keys.groq;
          if (!key) throw new Error('GROQ_API_KEY not configured');

          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              stream: true,
              max_tokens: 8192,
              temperature: 0.7,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Groq ${res.status}: ${err.slice(0, 300)}`);
          }

          await pipeOpenAIStream(res, send, (t) => { estimatedTokens = t; });

        } else if (provider === 'openai') {
          // ── OpenAI ────────────────────────────────────────────────────
          const key = keys.openai;
          if (!key) throw new Error('OPENAI_API_KEY not configured');

          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              stream: true,
              max_completion_tokens: 8192,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`OpenAI ${res.status}: ${err.slice(0, 300)}`);
          }

          await pipeOpenAIStream(res, send, (t) => { estimatedTokens = t; });

        } else if (provider === 'github') {
          // ── GitHub Models ─────────────────────────────────────────────
          const key = keys.github;
          if (!key) throw new Error('GITHUB_TOKEN not configured');

          const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              stream: true,
              max_tokens: 4096,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`GitHub Models ${res.status}: ${err.slice(0, 300)}`);
          }

          await pipeOpenAIStream(res, send, (t) => { estimatedTokens = t; });

        } else if (provider === 'openrouter') {
          // ── OpenRouter ────────────────────────────────────────────────
          const key = keys.openrouter;
          if (!key) throw new Error('OPENROUTER_API_KEY not configured');

          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${key}`,
              'HTTP-Referer': 'https://api-ai-agent.vercel.app',
              'X-Title': 'Jarvis AI Agent',
            },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              stream: true,
              max_tokens: 8192,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 300)}`);
          }

          await pipeOpenAIStream(res, send, (t) => { estimatedTokens = t; });

        } else if (provider === 'huggingface') {
          // ── HuggingFace Inference API ─────────────────────────────────
          const key = keys.hf;
          if (!key) throw new Error('HF_TOKEN not configured');

          const res = await fetch(`https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              stream: true,
              max_tokens: 4096,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`HuggingFace ${res.status}: ${err.slice(0, 300)}`);
          }

          await pipeOpenAIStream(res, send, (t) => { estimatedTokens = t; });

        } else {
          throw new Error(`Unknown provider: ${provider}`);
        }

        // Done
        send(`data: ${JSON.stringify({ type: 'done', model: modelId, provider, role: 'assistant', estimatedTokens })}\n\n`);

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[chat] Error:', msg);
        send(`data: ${JSON.stringify({ type: 'error', content: msg })}\n\n`);
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ── OpenAI-compatible stream parser (used by OpenAI / Groq / GitHub / OR / HF)
async function pipeOpenAIStream(
  res: Response,
  send: (s: string) => void,
  onTokenCount: (t: number) => void,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') return;
      try {
        const chunk = JSON.parse(raw);
        const text  = chunk.choices?.[0]?.delta?.content ?? '';
        if (text) send(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
        if (chunk.usage?.total_tokens) onTokenCount(chunk.usage.total_tokens);
      } catch { /* partial JSON — skip */ }
    }
  }
}
