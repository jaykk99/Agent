import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { message, history, settings } = await req.json();

    const apiKey = settings?.is_custom_gemini_key_enabled && settings?.custom_gemini_api_key
      ? settings.custom_gemini_api_key
      : process.env.GEMINI_API_KEY;

    if (!apiKey) return NextResponse.json({ error: 'No Gemini API key configured' }, { status: 400 });

    const modelName = settings?.is_custom_model_enabled && settings?.custom_model_endpoint
      ? null
      : (settings?.active_model_name || 'gemini-1.5-flash');

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

    // Gemini API
    const contents = [
      ...(history || []).map((h: { role: string; text: string }) => ({
        role: h.role,
        parts: [{ text: h.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      return NextResponse.json({ error: err }, { status: geminiRes.status });
    }

    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
    return NextResponse.json({ text });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
