import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — dependency-free liveness check for host health probes
 * (Render healthCheckPath). Never touches provider APIs; only reports which
 * integrations are configured so a deploy can be sanity-checked at a glance.
 */
export async function GET() {
  const has = (v: string | undefined) => Boolean(v && v.length > 0);
  return NextResponse.json({
    ok: true,
    service: 'jarvis-agent',
    uptime: Math.round(process.uptime()),
    providers: {
      gemini:     has(process.env.GEMINI_API_KEY),
      openai:     has(process.env.OPENAI_API_KEY),
      anthropic:  has(process.env.ANTHROPIC_API_KEY),
      groq:       has(process.env.GROQ_API_KEY),
      openrouter: has(process.env.OPENROUTER_API_KEY),
      huggingface:has(process.env.HF_TOKEN),
      github:     has(process.env.GITHUB_TOKEN),
      elevenlabs: has(process.env.ELEVENLABS_API_KEY),
    },
    integrations: {
      supabase: has(process.env.NEXT_PUBLIC_SUPABASE_URL),
      githubOauth: has(process.env.GITHUB_CLIENT_ID),
    },
  });
}
