#!/usr/bin/env bash
# docs/SCAN_PIPELINE.md + scan-pipeline/*.dot → docs/SCAN_PIPELINE.pdf (Graphviz, pandoc, Chrome).
set -euo pipefail
cd "$(dirname "$0")"
for f in scan-pipeline/*.dot; do
  sed -e '/^#include/{r scan-pipeline/style.inc' -e 'd}' "$f" | dot -Tsvg -o "${f%.dot}.svg"
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -r scan-pipeline pdf.css "$tmp/"
cat > "$tmp/extra.css" <<'CSS'
h1 { break-before: page; break-after: avoid; }
h1:first-of-type { break-before: auto; }
img { max-width: 100%; max-height: 21cm; display: block; margin: 0.6em auto; }
p:has(> img) { break-inside: avoid; }
table { font-size: 0.82em; }
CSS
pandoc SCAN_PIPELINE.md -f markdown-implicit_figures -s -c pdf.css -c extra.css -o "$tmp/pipeline.html"
google-chrome --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/SCAN_PIPELINE.pdf" "file://$tmp/pipeline.html" 2>/dev/null
echo "docs/SCAN_PIPELINE.pdf"
