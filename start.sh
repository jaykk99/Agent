#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────
#  Jarvis — Unified Launch Script
#  Works on: Android Termux, Linux, macOS
# ─────────────────────────────────────────────
set -e

# ── Paths & env ──────────────────────────────
REPO_DIR="${JARVIS_DIR:-$(cd "$(dirname "$0")" && pwd)}"
WEB_DIR="$REPO_DIR/web"
VOICE_PY="$REPO_DIR/voice.py"
# Ensure log dir exists (Termux uses $TMPDIR; fallback to /tmp)
_LOGDIR="${TMPDIR:-/tmp}"
mkdir -p "$_LOGDIR" 2>/dev/null || true
LOG="$_LOGDIR/jarvis.log"

export ELEVENLABS_API_KEY="${ELEVENLABS_API_KEY:-sk_8b5331aa2f2aed79d405d9f5f24fdec1a87f2b6f45574abe}"

# ── Dependency check ─────────────────────────
check_deps() {
  local missing=()
  command -v node   >/dev/null 2>&1 || missing+=("nodejs")
  command -v python3 >/dev/null 2>&1 || missing+=("python")
  if [ ${#missing[@]} -gt 0 ]; then
    echo "[setup] Installing missing packages: ${missing[*]}"
    pkg install -y "${missing[@]}" 2>/dev/null || apt-get install -y "${missing[@]}" 2>/dev/null || true
  fi
  # Python deps
  python3 -c "import requests" 2>/dev/null || pip install requests -q
}

# ── Install Node deps if needed ───────────────
install_web_deps() {
  if [ ! -d "$WEB_DIR/node_modules" ]; then
    echo "[setup] Installing Node.js dependencies..."
    cd "$WEB_DIR" && npm install --silent
  fi
}

# ── Voice test ───────────────────────────────
test_voice() {
  echo "[voice] Testing ElevenLabs voice..."
  python3 "$VOICE_PY" "Hello. I am Jarvis. Voice system online."
  echo "[voice] ✅ Voice test complete."
}

# ── Start web dev server ──────────────────────
start_web() {
  echo "[web] Starting Jarvis web interface..."
  cd "$WEB_DIR"
  # Port forwarding for Android Termux
  export PORT="${PORT:-3000}"
  echo "[web] Running at http://localhost:$PORT"
  # Run in background, stream logs
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  npm run dev 2>&1 | tee "$LOG" &
  WEB_PID=$!
  echo "[web] PID=$WEB_PID  |  Log: $LOG"
  # Announce startup via voice (non-blocking)
  sleep 4 && python3 "$VOICE_PY" "Jarvis web interface is ready." &
  wait $WEB_PID
}

# ── Main ─────────────────────────────────────
case "${1:-start}" in
  test-voice)
    check_deps
    test_voice
    ;;
  voice)
    # Pipe any text through Jarvis voice
    # Usage: echo "hello" | ./start.sh voice
    check_deps
    python3 "$VOICE_PY"
    ;;
  install)
    check_deps
    install_web_deps
    echo "[setup] ✅ All dependencies installed."
    ;;
  start|"")
    check_deps
    install_web_deps
    start_web
    ;;
  *)
    echo "Usage: $0 [start|install|test-voice|voice]"
    echo "  start       — install deps + start web interface (default)"
    echo "  install     — install all dependencies only"
    echo "  test-voice  — test ElevenLabs TTS voice"
    echo "  voice       — pipe stdin to Jarvis voice  (echo 'hi' | $0 voice)"
    exit 1
    ;;
esac
