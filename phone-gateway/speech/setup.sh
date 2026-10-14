#!/usr/bin/env bash
# One-time install of the local speech engines (Piper TTS, Whisper STT) into
# speech/.venv and speech/models. Needs python3 (3.10+) and sox.
#
# Usage: speech/setup.sh [piper-voice-name]   (default: en_US-lessac-medium)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
voice="${1:-en_US-lessac-medium}"

command -v sox >/dev/null || { echo "sox is required (apt install sox)" >&2; exit 1; }
[[ -d "$here/.venv" ]] || python3 -m venv "$here/.venv"
"$here/.venv/bin/pip" install -q piper-tts==1.8.0 faster-whisper==1.2.1

# Voice names look like <lang>_<REGION>-<speaker>-<quality>; browse them at
# https://huggingface.co/rhasspy/piper-voices
mkdir -p "$here/models"
IFS=- read -r locale speaker quality <<<"$voice"
lang="${locale%%_*}"
base="https://huggingface.co/rhasspy/piper-voices/resolve/main/$lang/$locale/$speaker/$quality"
for file in "$voice.onnx" "$voice.onnx.json"; do
  [[ -f "$here/models/$file" ]] || curl -fL --retry 3 -o "$here/models/$file" "$base/$file"
done
echo "Installed voice $voice. The Whisper model downloads on first start."
