#!/usr/bin/env bash
# Start the local speech server (Piper + Whisper) on 127.0.0.1:${SPEECH_PORT:-8090}.
# Usage: speech/start.sh [stop]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
port="${SPEECH_PORT:-8090}"
pidfile="$here/.server.pid"

if [[ "${1:-}" == "stop" ]]; then
  [[ -f "$pidfile" ]] && kill "$(cat "$pidfile")" 2>/dev/null || true
  rm -f "$pidfile"
  exit 0
fi
if curl -sf "http://127.0.0.1:$port/health" >/dev/null; then
  echo "Speech server already running on port $port"
  exit 0
fi
[[ -x "$here/.venv/bin/python" ]] || { echo "Run speech/setup.sh first" >&2; exit 1; }

nohup "$here/.venv/bin/python" -I "$here/server.py" >"$here/server.log" 2>&1 &
echo $! >"$pidfile"
for _ in $(seq 1 300); do
  if curl -sf "http://127.0.0.1:$port/health" >/dev/null; then
    echo "Speech server ready on http://127.0.0.1:$port (log: speech/server.log)"
    exit 0
  fi
  sleep 1
done
echo "Speech server did not start; see $here/server.log" >&2
exit 1
