<div align="center">
  <h1>🤖 Jarvis — AI Agent Platform</h1>
  <p><strong>Multi-model AI agent with voice (ElevenLabs), hardware monitor, live streaming, GitHub context injection, and cross-platform deployment</strong></p>

  <p>
    <a href="https://api-ai-agent.vercel.app">🌐 Live Demo</a> |
    <a href="#quick-start">⚡ Quick Start</a> |
    <a href="#android-termux">📱 Android / Termux</a> |
    <a href="#voice">🔊 Voice</a>
  </p>
</div>

---

## ✨ Features

| Feature | Details |
|---|---|
| 🧠 **Multi-model AI** | Claude, GPT-4, Gemini, Groq Llama, DeepSeek, Mistral, HuggingFace, OpenRouter (200+ models) |
| 🔊 **ElevenLabs Voice** | Every AI response spoken aloud — toggle per session, six voices |
| 📊 **Hardware Monitor** | Live context-fill bar + latency + device RAM displayed in chat |
| ⚡ **Live Streaming** | Word-by-word SSE streaming with blinking cursor |
| 🐙 **GitHub Injection** | Attach a repo → full tree injected as context |
| 🛠️ **Tool Calls** | Persistent tool-call logs in Supabase |
| 🔒 **Rate Limiting** | 20 req/60s per-IP token bucket |
| ☁️ **Vercel Deploy** | Zero-config, one-command deployment |

---

## 🚀 Quick Start

### Web (Vercel / Local)

```bash
# 1. Clone
git clone https://github.com/jaykk99/Agent.git
cd Agent/web

# 2. Install dependencies
npm install

# 3. Add environment variables
cp .env.example .env.local
# Edit .env.local — minimum required:
#   GROQ_API_KEY=...
#   ANTHROPIC_API_KEY=...    (optional — Claude models)
#   GEMINI_API_KEY=...       (optional — Gemini models)
#   ELEVENLABS_API_KEY=sk_8b5331aa2f2aed79d405d9f5f24fdec1a87f2b6f45574abe

# 4. Start dev server
npm run dev
# → http://localhost:3000

# 5. Production build
npm run build && npm start
```

### One-command deploy to Vercel
```bash
npm i -g vercel
cd Agent/web
vercel --prod
# Set env vars in Vercel dashboard or via:
vercel env add ELEVENLABS_API_KEY
```

---

## 📱 Android / Termux {#android-termux}

### First-time setup

```bash
# 1. Install core packages
pkg update && pkg install -y git nodejs python mpv

# 2. Install Python deps
pip install requests

# 3. Clone the repo
git clone https://github.com/jaykk99/Agent.git ~/jarvis
cd ~/jarvis

# 4. Make start script executable
chmod +x start.sh

# 5. Install Node deps + test voice
./start.sh install
./start.sh test-voice
```

### Launch commands

```bash
# ── Standard start (web + voice) ──────────────────────────
./start.sh

# ── Test voice only ───────────────────────────────────────
./start.sh test-voice

# ── Pipe any text through Jarvis voice ───────────────────
echo "Hello, I am Jarvis" | ./start.sh voice
echo "Analysis complete" | python3 voice.py

# ── Install / update dependencies only ───────────────────
./start.sh install

# ── Manual web start ─────────────────────────────────────
cd web && npm run dev
```

### Termux shortcut (optional)
Add to `~/.bashrc` or `~/.zshrc`:
```bash
alias jarvis="cd ~/jarvis && ./start.sh"
alias jarvis-voice="python3 ~/jarvis/voice.py"
```

---

## 🔊 Voice (ElevenLabs) {#voice}

Jarvis reads every AI response aloud using ElevenLabs TTS.

### Web UI
1. Open **Model Settings** tab → scroll to **Voice**
2. Toggle "Enable voice"
3. Pick a voice — Adam (default), Rachel, Josh, Bella, Domi, Sam
4. The 🔊 toolbar button mutes / stops mid-speech

### Android / Termux
```bash
# Test voice directly
./start.sh test-voice

# Speak any text
echo "Systems online" | python3 voice.py

# Change voice (set env var before running)
JARVIS_VOICE_ID=21m00Tcm4TlvDq8ikWAM python3 voice.py "Hello, I am Rachel"
```

### Available voices

| Voice ID | Name | Style |
|---|---|---|
| `pNInz6obpgDQGcFmaJgB` | **Adam** (default) | Deep, assertive |
| `21m00Tcm4TlvDq8ikWAM` | Rachel | Calm, natural |
| `TxGEqnHWrfWFTfGW9XjX` | Josh | Young, energetic |
| `EXAVITQu4vr4xnSDxMaL` | Bella | Soft, friendly |
| `AZnzlk1XvdvUeBnXmlld` | Domi | Strong, confident |
| `yoZ06aMxZJJ28mfd3POQ` | Sam | Newsreader style |

### ElevenLabs API key
The server key is pre-configured in Vercel (`ELEVENLABS_API_KEY`).  
To use your own key locally:
```bash
export ELEVENLABS_API_KEY=sk_your_key_here
./start.sh test-voice
```

---

## 📊 Hardware Monitor

A live status bar above chat messages shows:

| Metric | Meaning |
|---|---|
| Context fill bar | Tokens used vs model max window — yellow > 50%, red > 80% |
| Latency | Time from send → full response |
| Device RAM | `navigator.deviceMemory` (browser API) |
| ⚠ Warning | "Context almost full — start new chat" when > 80% |

---

## 🌐 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | ✅ | Llama, Mixtral, DeepSeek (default models) |
| `ANTHROPIC_API_KEY` | Optional | Claude 3.5 Sonnet/Haiku/Opus |
| `GEMINI_API_KEY` | Optional | Gemini 2.5 Pro/Flash |
| `OPENROUTER_API_KEY` | Optional | 200+ models via OpenRouter |
| `HF_TOKEN` | Optional | Gated HuggingFace models |
| `ELEVENLABS_API_KEY` | Optional | Voice TTS (server key pre-configured) |
| `GITHUB_TOKEN` | Optional | GitHub repo context injection |
| `NEXT_PUBLIC_SUPABASE_URL` | Optional | Message persistence |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Optional | Supabase auth |

---

## 🏗️ Project Structure

```
Agent/
├── voice.py              # ElevenLabs TTS — use anywhere (web/Android)
├── start.sh              # One-command launcher (Termux / Linux)
├── web/                  # Next.js 14 TypeScript web app
│   ├── app/
│   │   ├── page.tsx      # Main chat UI + hardware monitor + voice toggle
│   │   └── api/
│   │       ├── chat/     # Multi-model streaming SSE endpoint
│   │       ├── tts/      # ElevenLabs TTS proxy
│   │       └── ...
│   └── lib/
│       ├── orchestrator.ts    # Multi-agent routing (6 specialist roles)
│       ├── agentState.ts      # Procedural state + memory decay
│       └── workspaceSkills.ts # 100-skill workspace
├── app/                  # Android Kotlin app
└── README.md
```

---

## 🛠️ Troubleshooting

**Voice not working on Android**
```bash
pkg install mpv          # install audio player
./start.sh test-voice    # test API + playback
```

**Port 3000 in use**
```bash
PORT=3001 ./start.sh
```

**Node modules missing**
```bash
./start.sh install
```

**ElevenLabs 503**  
Server key is active — check Vercel env vars or set `ELEVENLABS_API_KEY` locally.

---

<div align="center">
  <p><strong>Built by <a href="https://github.com/jaykk99">@jaykk99</a></strong></p>
  <p>
    <a href="https://github.com/jaykk99/Agent">GitHub</a> |
    <a href="https://api-ai-agent.vercel.app">Live Demo</a>
  </p>
</div>
