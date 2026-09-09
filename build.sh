#!/usr/bin/env bash
# Packages the extension for both stores.
#
#   dist/absolute-cinema-chrome.zip   Chrome Web Store  (browser_specific_settings stripped)
#   dist/absolute-cinema-firefox.zip  AMO               (full manifest, gecko id intact)
#
# Chrome ignores browser_specific_settings but logs "Unrecognized manifest key"
# on every unpacked load, and the store validator has no reason to see it.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist && mkdir -p dist/stage
cp -R manifest.json src icons fonts dist/stage/
find dist/stage -name '.DS_Store' -delete

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")

# Firefox: ship the manifest as-is.
(cd dist/stage && zip -qr "../absolute-cinema-firefox.zip" .)

# Chrome: drop the Firefox-only key.
python3 - <<'PY'
import json
p = 'dist/stage/manifest.json'
m = json.load(open(p))
m.pop('browser_specific_settings', None)
json.dump(m, open(p, 'w'), indent=2)
open(p, 'a').write('\n')
PY
(cd dist/stage && zip -qr "../absolute-cinema-chrome.zip" .)

rm -rf dist/stage
echo "v${VERSION}"
for f in dist/*.zip; do
  printf '  %-34s %s\n' "$f" "$(du -h "$f" | cut -f1)"
done
