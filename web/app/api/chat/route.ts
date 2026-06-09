import { NextRequest, NextResponse } from 'next/server';

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function callGemini(apiKey: string, model: string, contents: object[], useSearch: boolean) {
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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

    const useSearch = !!settings?.enable_web_search;

    const contents = [
      ...(history || []).map((h: { role: string; text: string }) => ({
        role: h.role,
        parts: [{ text: h.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    // Build model priority list
    const requested = settings?.active_model_name || 'gemini-2.5-flash';
    const modelsToTry = [requested, ...FALLBACK_MODELS.filter(m => m !== requested)];

    let lastErr = '';
    for (const model of modelsToTry) {
      const geminiRes = await callGemini(apiKey, model, contents, useSearch);
      if (geminiRes.ok) {
        const geminiData = await geminiRes.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
        const note = model !== requested ? `\n\n_(used ${model} — ${requested} was temporarily unavailable)_` : '';

        // Include search grounding sources if available
        const groundingMeta = geminiData.candidates?.[0]?.groundingMetadata;
        let sourceNote = '';
        if (groundingMeta?.groundingChunks?.length) {
          const sources = groundingMeta.groundingChunks
            .slice(0, 5)
            .map((c: { web?: { uri: string; title: string } }) => c.web ? `[${c.web.title || c.web.uri}](${c.web.uri})` : null)
            .filter(Boolean)
            .join(' · ');
          if (sources) sourceNote = `\n\n🔍 Sources: ${sources}`;
        }

        return NextResponse.json({ text: text + note + sourceNote });
      }
      const errText = await geminiRes.text();
      let errCode: number | undefined;
      try { errCode = JSON.parse(errText)?.error?.code; } catch { /* ignore */ }
      lastErr = errText;
      if (errCode !== 503 && errCode !== 429 && errCode !== 404) break;
    }

    return NextResponse.json({ error: lastErr }, { status: 500 });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
