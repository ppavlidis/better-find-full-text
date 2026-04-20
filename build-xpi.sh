#!/usr/bin/env bash
# Packages the plugin as an XPI file that can be installed via Zotero → Tools → Add-ons.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$PLUGIN_DIR/better-find-full-text.xpi"

cd "$PLUGIN_DIR"
zip -r "$OUT" manifest.json bootstrap.js better-find-full-text.js content/

echo "Built: $OUT"
