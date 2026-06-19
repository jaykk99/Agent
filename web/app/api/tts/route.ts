import { NextRequest, NextResponse } from 'next/server';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

export async function POST(req: NextRequest) {
  const { text, voice_id } = await req.json() as { text: string; voice_id?: string };
  if (!text?.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });

  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  if (!apiKey) return NextResponse.json({ error: 'TTS not configured on server' }, { status: 503 });

  const voiceId = voice_id || 'pNInz6obpgDQGcFmaJgB'; // Adam — assertive, clear
  try {
    const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        text: text.slice(0, 2000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `ElevenLabs error: ${err.slice(0, 200)}` }, { status: 502 });
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** GET /api/tts/voices — list available voices */
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  if (!apiKey) return NextResponse.json({ voices: [] });
  try {
    const res = await fetch(`${ELEVENLABS_BASE}/voices`, { headers: { 'xi-api-key': apiKey } });
    const data = await res.json() as { voices?: Array<{ voice_id: string; name: string; preview_url?: string }> };
    return NextResponse.json({ voices: (data.voices ?? []).map(v => ({ id: v.voice_id, name: v.name, preview_url: v.preview_url })) });
  } catch { return NextResponse.json({ voices: [] }); }
}
