#!/usr/bin/env python3
"""
Jarvis Voice — ElevenLabs TTS
Works on: Android Termux, Linux, macOS, WSL

Usage:
  echo "Hello" | python3 voice.py
  python3 voice.py "Hello, I am Jarvis"
  cat response.txt | python3 voice.py

Setup:
  pip install requests
  # mpv recommended for audio playback:
  #   Android Termux : pkg install mpv
  #   Linux          : sudo apt install mpv
  #   macOS          : brew install mpv
"""
import sys, os, re, subprocess, requests

API_KEY  = os.environ.get("ELEVENLABS_API_KEY", "sk_8b5331aa2f2aed79d405d9f5f24fdec1a87f2b6f45574abe")
VOICE_ID = os.environ.get("JARVIS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")   # Adam — deep & assertive
MODEL    = "eleven_multilingual_v2"
TMPDIR   = os.environ.get("TMPDIR", "/tmp")
TMP_MP3  = os.path.join(TMPDIR, "jarvis_voice.mp3")

def clean(text: str) -> str:
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"[#*`_~\[\]>|]", "", text)
    text = re.sub(r"\n+", " ", text)
    return re.sub(r"\s{2,}", " ", text).strip()[:1500]

def play(path: str) -> None:
    for cmd in [["mpv","--really-quiet",path],
                ["termux-media-player","play",path],
                ["ffplay","-nodisp","-autoexit","-loglevel","quiet",path],
                ["afplay",path],
                ["aplay",path]]:
        try:
            if subprocess.run(cmd, capture_output=True, timeout=90).returncode == 0:
                return
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    print("[voice] No audio player found.  Install: pkg install mpv  (Android) | apt install mpv  (Linux)", file=sys.stderr)

def speak(text: str) -> None:
    text = clean(text)
    if not text: return
    print(f"[Jarvis voice] {text[:80]}{'...' if len(text)>80 else ''}", file=sys.stderr)
    try:
        res = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
            headers={"xi-api-key": API_KEY, "Content-Type": "application/json"},
            json={"text": text, "model_id": MODEL,
                  "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.1, "use_speaker_boost": True}},
            timeout=25,
        )
    except requests.RequestException as e:
        print(f"[voice] Network error: {e}", file=sys.stderr); return
    if res.status_code != 200:
        print(f"[voice] ElevenLabs {res.status_code}: {res.text[:200]}", file=sys.stderr); return
    with open(TMP_MP3, "wb") as f:
        f.write(res.content)
    play(TMP_MP3)

if __name__ == "__main__":
    speak(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.read())
