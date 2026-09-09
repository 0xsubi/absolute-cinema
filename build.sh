#!/usr/bin/env bash
# Packages the extension into dist/absolute-cinema.zip.
# The same zip loads in Chrome (Web Store / unpacked) and Firefox (AMD / temporary add-on).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
zip -qr dist/absolute-cinema.zip manifest.json src icons fonts \
  -x '*.DS_Store' '*/.*'
echo "dist/absolute-cinema.zip  ($(du -h dist/absolute-cinema.zip | cut -f1))"
