#!/bin/sh
# Dev build that tolerates modules other agents are mid-edit: any src/js file that fails `node --check`
# is replaced (for this build only) by its last committed version. Output: dist/lead.html (served at /lead.html),
# so it never collides with dist/index.html that other agents rebuild for their own tests.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd); T=$(mktemp -d)
cp "$ROOT"/src/js/*.js "$T"/
for f in "$T"/*.js; do
  if ! node --check "$f" >/dev/null 2>&1; then b=$(basename "$f"); echo "devbuild: $b is mid-edit, using the committed copy"; git -C "$ROOT" show "HEAD:src/js/$b" > "$f"; fi
done
BAYLINE_JS_DIR="$T" BAYLINE_OUT="${BAYLINE_OUT:-dist/lead.html}" python3 "$ROOT/build.py"; rm -rf "$T"
