#!/usr/bin/env bash
# Monthly: rebuild the local title / author index (ref_titles, ref_authors) from the latest
# Hebrew Wikipedia dump, Wikidata and the Project Ben-Yehuda catalogue (runs on the server).
#   deploy/refs-refresh.sh [DATA_DIR]
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${1:-$HOME/seferehov-data/refs}"
mkdir -p "$DATA" && cd "$DATA"
UA="Seferehov/0.1 (https://seferehov.com; book title index)"
curl -s -L -A "$UA" -o hewiki.xml.bz2.part -z hewiki.xml.bz2 \
  https://dumps.wikimedia.org/hewiki/latest/hewiki-latest-pages-articles.xml.bz2 \
  && { [[ -s hewiki.xml.bz2.part ]] && mv hewiki.xml.bz2.part hewiki.xml.bz2 || rm -f hewiki.xml.bz2.part; }
cd "$APP_DIR/server"
node --env-file=../.env scripts/import-refs.js benyehuda
node --max-old-space-size=4000 --env-file=../.env scripts/import-refs.js hewiki "$DATA/hewiki.xml.bz2"
node --env-file=../.env scripts/import-refs.js wikidata
