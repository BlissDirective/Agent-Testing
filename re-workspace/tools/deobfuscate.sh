#!/usr/bin/env bash
# Pass 1 of JS deobfuscation: run webcrack (no LLM) on a bundle in ./target.
#
# Usage: tools/deobfuscate.sh target/bundle.js [name]
# Output goes to work/<name>/ (name defaults to the input's basename).
# The original in ./target is never touched.
set -euo pipefail

WEBCRACK_VERSION="2.16.0"

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: tools/deobfuscate.sh target/bundle.js [name]" >&2
  exit 1
fi

input="$1"
if [[ ! -f "$input" ]]; then
  echo "No such file: $input" >&2
  exit 1
fi

name="${2:-$(basename "$input" .js)}"
if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Name may only contain letters, digits, '.', '_' and '-': $name" >&2
  exit 1
fi

workspace="$(cd "$(dirname "$0")/.." && pwd)"
output="$workspace/work/$name"
if [[ -e "$output" ]]; then
  echo "Already exists, remove it first: $output" >&2
  exit 1
fi

mkdir -p "$workspace/work"
npx --yes "webcrack@$WEBCRACK_VERSION" "$input" -o "$output"
echo "Deobfuscated output written to $output"
