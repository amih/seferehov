#!/usr/bin/env bash
# docs/FEATURES.md → docs/FEATURES.pdf and docs/CONFIDENCE_REVIEW.md → docs/CONFIDENCE_REVIEW.pdf
# (pandoc for the HTML, Chrome for the PDF).
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp pdf.css "$tmp/"
pandoc FEATURES.md -s --toc --toc-depth=2 -c pdf.css -o "$tmp/features.html"
google-chrome --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/FEATURES.pdf" "file://$tmp/features.html" 2>/dev/null
echo "docs/FEATURES.pdf"
echo 'h1 { break-after: avoid; } table { font-size: 0.85em; } tr { break-inside: avoid; }' > "$tmp/review.css"
pandoc CONFIDENCE_REVIEW.md -s -c pdf.css -c review.css -o "$tmp/review.html"
google-chrome --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/CONFIDENCE_REVIEW.pdf" "file://$tmp/review.html" 2>/dev/null
echo "docs/CONFIDENCE_REVIEW.pdf"
