/** Tests for lib/models.ts (model registry + provider resolution) and lib/appUrl.ts. */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, resolveModel } from '../lib/models.ts';
import { appUrl } from '../lib/appUrl.ts';

describe('model registry', () => {
  it('every model id is unique', () => {
    const ids = MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length > 20);
  });

  it('resolves direct registry hits', () => {
    assert.deepEqual(resolveModel('gemini-2.5-flash'), {
      modelId: 'gemini-2.5-flash', provider: 'gemini', label: '☁ Gemini 2.5 Flash', cloud: true,
    });
    const gh = resolveModel('gh:gpt-4.1');
    assert.equal(gh.modelId, 'gpt-4.1');
    assert.equal(gh.provider, 'github');
  });

  it('strips gh:/hf:/or: prefixes onto the matching provider', () => {
    assert.equal(resolveModel('hf:mistralai/Mistral-7B-Instruct-v0.3').provider, 'huggingface');
    assert.equal(resolveModel('or:openai/gpt-4o').provider, 'openrouter');
    assert.equal(resolveModel('or:openai/gpt-4o').modelId, 'openai/gpt-4o');
  });

  it('infers provider from unlisted model names', () => {
    assert.equal(resolveModel('gemini-3-flash').provider, 'gemini');
    assert.equal(resolveModel('claude-haiku-x').provider, 'anthropic');
    assert.equal(resolveModel('gpt-5-mini').provider, 'openai');
    assert.equal(resolveModel('o4-reasoner').provider, 'openai');
    assert.equal(resolveModel('llama-4-scout').provider, 'groq');
    assert.equal(resolveModel('meta-llama/llama-4').provider, 'openrouter');
    assert.equal(resolveModel('some-unknown-model').provider, 'gemini'); // default
  });

  it('marks huggingface models as non-cloud', () => {
    assert.equal(resolveModel('hf:Qwen/Qwen2.5-72B-Instruct').cloud, false);
    assert.equal(resolveModel('gpt-4o').cloud, true);
  });
});

describe('appUrl', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  it('prefers APP_URL, falls back through NEXTAUTH_URL and VERCEL_URL', () => {
    delete process.env.APP_URL; delete process.env.NEXTAUTH_URL; delete process.env.VERCEL_URL;
    assert.equal(appUrl(), 'http://localhost:3000');
    process.env.VERCEL_URL = 'my-app.vercel.app';
    assert.equal(appUrl(), 'https://my-app.vercel.app');
    process.env.NEXTAUTH_URL = 'https://old.example.com';
    assert.equal(appUrl(), 'https://old.example.com');
    process.env.APP_URL = 'https://jarvis.onrender.com/';
    assert.equal(appUrl(), 'https://jarvis.onrender.com'); // trailing slash trimmed
  });
});
