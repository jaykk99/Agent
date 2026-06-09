import { NextRequest, NextResponse } from 'next/server';

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function callGemini(apiKey: string, model: string, contents: object[]) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } })
    }
  );
  return res;
}

export async function POST(req: NextRequest) {
  try {
    const { message, history, settings } = await req.json();

    const apiKey = settings?.is_custom_gemini_key_enabled && settings?.custom_gemini_api_key
      ? settings.custom_gemini_api_key
      : process.env.GEMINI_API_KEY;

    if (!apiKey) return NextResponse.json({ error: 'No Gemini API key configured' }, { status: 400 });

    // Use custom model endpoint if configured
    if (settings?.is_custom_model_enabled && settings?.custom_model_endpoint) {
      const res = await fetch(settings.custom_model_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.custom_model_api_key}` },
        body: JSON.stringify({
          model: settings.custom_model_name || 'gpt-4o-mini',
          messages: [
            ...(history || []).map((h: { role: string; text: string }) => ({ role: h.role === 'model' ? 'assistant' : h.role, content: h.text })),
            { role: 'user', content: message }
          ]
        })
      });
      const data = await res.json();
      return NextResponse.json({ text: data.choices?.[0]?.message?.content || 'No response' });
    }

    const contents = [
      ...(history || []).map((h: { role: string; text: string }) => ({
        role: h.role,
        parts: [{ text: h.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    // Build model priority list: requested model first, then fallbacks
    const requested = settings?.active_model_name || 'gemini-2.5-flash';
    const modelsToTry = [requested, ...FALLBACK_MODELS.filter(m => m !== requested)];

    let lastErr = '';
    for (const model of modelsToTry) {
      const geminiRes = await callGemini(apiKey, model, contents);
      if (geminiRes.ok) {
        const geminiData = await geminiRes.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
        // Surface which model was used if it fell back
        const note = model !== requested ? ` (using ${model} — ${requested} was temporarily unavailable)` : '';
        return NextResponse.json({ text: text + note });
      }
      const errText = await geminiRes.text();
      const errJson = JSON.parse(errText || '{}');
      const code = errJson?.error?.code;
      lastErr = errText;
      // Only retry on transient errors (503) or quota (429) — stop on auth/bad request
      if (code !== 503 && code !== 429 && code !== 404) break;
    }

    return NextResponse.json({ error: lastErr }, { status: 500 });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
