/**
 * web/lib/models.ts — model registry + provider resolution (extracted from app/api/chat/route.ts).
 * Pure module: safe to unit-test without Next.js.
 */

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

export type ModelEntry = (typeof MODELS)[number];
export type Provider   = ModelEntry['provider'];

export function resolveModel(rawId: string): { modelId: string; provider: Provider; label: string; cloud: boolean } {
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
