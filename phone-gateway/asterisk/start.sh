#!/usr/bin/env bash
# Start (or stop) the gateway's own Asterisk instance, separate from any
# system Asterisk. Runtime files go in ./.run (or $ASTERISK_RUN_DIR).
#
# Usage: asterisk/start.sh [stop|cli]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
run="${ASTERISK_RUN_DIR:-$here/.run}"
conf="$run/etc/asterisk.conf"

case "${1:-start}" in
  stop)
    asterisk -C "$conf" -rx "core stop now" || true
    exit 0
    ;;
  cli)
    exec asterisk -C "$conf" -r
    ;;
esac

mkdir -p "$run"/{etc,db,spool/recording,run,log}
cp "$here"/etc/*.conf "$run/etc/"
sed -i "s#__ETC__#$run/etc#; s#__RUN__#$run#g" "$conf"

if asterisk -C "$conf" -rx "core show version" >/dev/null 2>&1; then
  echo "Asterisk already running ($run)"
  exit 0
fi
asterisk -C "$conf"
for _ in $(seq 1 50); do
  if asterisk -C "$conf" -rx "ari show status" 2>/dev/null | grep -q "ARI Status"; then
    echo "Asterisk running. ARI on http://127.0.0.1:8088, SIP on udp/5060, recordings in $run/spool/recording"
    exit 0
  fi
  sleep 0.2
done
echo "Asterisk did not start; see $run/log/messages" >&2
exit 1
