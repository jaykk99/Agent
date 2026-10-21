/**
 * web/app/api/chat/route.ts
 * Jarvis — Multi-Provider Streaming Chat
 * Providers: Gemini · OpenAI · Anthropic · Groq · OpenRouter · HuggingFace
 */
import { NextRequest, NextResponse } from 'next/server';
import { appUrl } from '@/lib/appUrl';
import { rateLimit, pruneExpiredBuckets, getClientIp } from '@/lib/rateLimit';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';
export const maxDuration = 60;

import { MODELS, resolveModel, type Provider } from '@/lib/models';

// ── GET — model list ────────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ models: MODELS });
}

// ── POST — main chat handler ────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 20 req/60s per-IP token bucket (shared lib impl, with Retry-After on 429).
  const ip = getClientIp(req);
  const rl = rateLimit(ip, 'chat', 20, 60);
  pruneExpiredBuckets(60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${rl.retryAfter ?? 60}s.` },
      { status: 429, headers: rl.retryAfter ? { 'Retry-After': String(rl.retryAfter) } : undefined },
    );
  }

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

  // ── Server-side input validation (frontend enforces 20k; this is the hard ceiling) ──
  const MAX_MSG_CHARS = 50_000;
  const MAX_HISTORY   = 30;
  for (const m of messages) {
    if (typeof m.content !== 'string') {
      return NextResponse.json({ error: 'Each message content must be a string' }, { status: 400 });
    }
    if (m.content.length > MAX_MSG_CHARS) {
      return NextResponse.json({ error: `Message too long (${m.content.length} chars). Limit is ${MAX_MSG_CHARS}.` }, { status: 400 });
    }
  }
  const trimmed = messages.slice(-MAX_HISTORY).map(m => ({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content.slice(0, MAX_MSG_CHARS),
  }));
  messages.length = 0;
  messages.push(...trimmed);

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

  // Keyless-first: does the selected provider have a usable key?
  const providerKey: Record<Provider, string> = {
    gemini: keys.gemini, openai: keys.openai, anthropic: keys.anthropic,
    groq: keys.groq, openrouter: keys.openrouter, github: keys.github,
    huggingface: keys.hf,
  };
  const hasKey = (providerKey[provider] ?? '').length > 0;

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

        if (!hasKey) {
          // ── Keyless fallback — Pollinations free tier (no API key needed) ──
          send(`data: ${JSON.stringify({ type: 'info', content: `No API key configured for ${provider} — using the free keyless fallback (Pollinations). Add a provider key in settings for full ${label} access.` })}\n\n`);

          const res = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'openai',
              messages: [{ role: 'system', content: systemPrompt }, ...messages],
              stream: true,
            }),
            signal: AbortSignal.timeout(55_000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Keyless fallback unavailable (${res.status}): ${err.slice(0, 200)}. Add a provider API key in settings.`);
          }

          await pipeOpenAIStream(res, send, (t) => { estimatedTokens = t; });

        } else if (provider === 'gemini') {
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
              'HTTP-Referer': appUrl(),
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
