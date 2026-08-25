#!/usr/bin/env bash
# Import art from a content drop into public/assets/ with normalized kebab-case names.
# Content drops are gitignored staging; only the normalized copies here are committed.
#
# Usage: tools/import-assets.sh ContentDrop-8-25-26
set -euo pipefail

DROP="${1:?usage: tools/import-assets.sh <content-drop-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/$DROP" ] || { echo "no such drop: $DROP" >&2; exit 1; }

norm() { echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' _' '--' | sed 's/--*/-/g'; }

copy() { # copy <src> <dest-dir>
  local src="$1" dir="$2" base
  base="$(norm "$(basename "$src")")"
  mkdir -p "$ROOT/public/assets/$dir"
  cp "$src" "$ROOT/public/assets/$dir/$base"
  echo "  $dir/$base  <-  ${src#$ROOT/}"
}

echo "importing from $DROP:"
find "$ROOT/$DROP" -type f \( -name '*.png' -o -name '*.json' \) -path '*Character*' -print0 \
  | while IFS= read -r -d '' f; do copy "$f" characters; done
find "$ROOT/$DROP" -type f \( -name '*.png' -o -name '*.json' \) -path '*Tileset*' -print0 \
  | while IFS= read -r -d '' f; do copy "$f" terrain; done
echo "done."
