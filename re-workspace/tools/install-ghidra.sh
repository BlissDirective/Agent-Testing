#!/usr/bin/env bash
# Install the Ghidra version REA is verified against into /opt, for a fresh
# container. Needs a 64-bit JDK 21+ (javac included) already on the machine.
#
# Usage: tools/install-ghidra.sh
set -euo pipefail

VERSION="12.1.4"
BUILD_DATE="20260921"
SHA256="ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db"
URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${VERSION}_build/ghidra_${VERSION}_PUBLIC_${BUILD_DATE}.zip"
DEST="/opt/ghidra_${VERSION}_PUBLIC"

if [[ -x "$DEST/support/analyzeHeadless" ]]; then
  echo "Ghidra $VERSION already installed at $DEST"
  exit 0
fi

download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT

curl -fL --retry 3 -o "$download_dir/ghidra.zip" "$URL"
echo "$SHA256  $download_dir/ghidra.zip" | sha256sum -c -
unzip -q "$download_dir/ghidra.zip" -d /opt
echo "Ghidra $VERSION installed at $DEST"
