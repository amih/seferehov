#!/usr/bin/env bash
# docs/FEATURES.md → docs/FEATURES.pdf (pandoc for the HTML, Chrome for the PDF).
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pandoc FEATURES.md -s --toc --toc-depth=2 -c pdf.css -o "$tmp/features.html"
cp pdf.css "$tmp/"
google-chrome --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/FEATURES.pdf" "file://$tmp/features.html" 2>/dev/null
echo "docs/FEATURES.pdf"
