#!/usr/bin/env bash
# Bring a target into ./target: clone a git repo or download a direct link.
#
# Usage: tools/fetch-target.sh [--allow-large] URL [name]
#   Git repos (…/owner/repo on GitHub/GitLab/Bitbucket, *.git, git@…) are
#   shallow-cloned. Anything else is downloaded; zip/tar archives are also
#   extracted safely next to the original.
#   Output: target/<name>/ (name defaults to the repo or file name).
#   Provenance (URL, date, SHA-256) is appended to notes/sources.md.
#
# Exit code 3: the download is over 5 GB. Ask the user, then rerun with
# --allow-large. Nothing fetched is ever run.
set -euo pipefail

LARGE_BYTES=$((5 * 1024 * 1024 * 1024))
EXIT_TOO_LARGE=3

allow_large=""
if [[ "${1:-}" == "--allow-large" ]]; then
  allow_large="--allow-large"
  shift
fi
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: tools/fetch-target.sh [--allow-large] URL [name]" >&2
  exit 1
fi
url="$1"

workspace="$(cd "$(dirname "$0")/.." && pwd)"
url_path="${url%%[?#]*}"
url_path="${url_path%/}"

is_git=""
if [[ "$url" == git@* || "$url_path" == *.git ||
      "$url_path" =~ ^https?://(www\.)?(github\.com|gitlab\.com|bitbucket\.org)/[^/]+/[^/]+$ ]]; then
  is_git=1
fi

default_name="$(basename "$url_path")"
default_name="${default_name%.git}"
name="${2:-${default_name:-download}}"
if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ || "$name" == "." || "$name" == ".." ]]; then
  echo "Name may only contain letters, digits, '.', '_' and '-': $name" >&2
  exit 1
fi

dest="$workspace/target/$name"
if [[ -e "$dest" ]]; then
  echo "Already exists, remove it first: $dest" >&2
  exit 1
fi

record() {
  local sources="$workspace/notes/sources.md"
  [[ -f "$sources" ]] || printf '# Target sources\n\n' > "$sources"
  printf -- '- `target/%s` from %s (%s, %s)\n' \
    "$name" "$url" "$(date -u +%Y-%m-%dT%H:%MZ)" "$1" >> "$sources"
}

if [[ -n "$is_git" ]]; then
  # No hooks, no submodules, LFS files stay as pointers.
  GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null clone \
    --depth 1 --no-recurse-submodules "$url" "$dest"
  commit="$(git -C "$dest" rev-parse HEAD)"
  record "git commit $commit"
  echo "Cloned to $dest at $commit"
  exit 0
fi

# Check size before downloading (servers that don't report it are allowed).
size="$(curl -sSIL "$url" | tr -d '\r' |
  awk 'tolower($1)=="content-length:"{n=$2} END{print n+0}')"
if (( size > LARGE_BYTES )) && [[ -z "$allow_large" ]]; then
  echo "Download is $((size / 1024 / 1024 / 1024)) GB (over 5 GB)." \
    "Ask the user, then rerun with --allow-large." >&2
  exit $EXIT_TOO_LARGE
fi

file_name="$(basename "$url_path")"
[[ "$file_name" =~ ^[A-Za-z0-9._-]+$ ]] || file_name="download"
mkdir -p "$dest"
if ! curl -fL --retry 3 -o "$dest/$file_name" "$url"; then
  rm -rf "$dest"
  exit 1
fi
chmod a-x "$dest/$file_name"
sha="$(sha256sum "$dest/$file_name" | cut -d' ' -f1)"
record "sha256 $sha"
echo "Downloaded $dest/$file_name ($(du -h "$dest/$file_name" | cut -f1), sha256 $sha)"

case "$file_name" in
  *.zip|*.tar|*.tgz|*.tar.gz|*.tar.bz2|*.tbz2|*.tar.xz|*.txz)
    python3 -I "$workspace/tools/safe_extract.py" \
      "$dest/$file_name" "$dest/$file_name.extracted" $allow_large
    ;;
esac
