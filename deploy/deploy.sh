#!/usr/bin/env bash
# Build locally, ship to the server, migrate, restart.
#   deploy/deploy.sh            (target from deploy/target.private: SSH=user@host APP_DIR=/path)
#   SKIP_TESTS=1 deploy/deploy.sh   (build only, no tests)
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/target.private

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit your changes first (the build version comes from the git commit)." >&2
  exit 1
fi

# Lint, unit tests, the build and the end-to-end run (test/e2e.test.js); a failure stops
# the deploy. SKIP_TESTS=1 deploy/deploy.sh only builds (an emergency fix).
# A commit that already passed before its push (.githooks/pre-push) is only built.
if [[ "${SKIP_TESTS:-}" == 1 ]] || grep -qx "$(git rev-parse HEAD)" "$(git rev-parse --git-common-dir)/tested-commits" 2>/dev/null; then
  npm run build
else
  npm test
fi

# Old hashed assets are kept (no --delete under assets/) so a tab still running
# the previous version can lazy-load its chunks until it updates.
rsync -az --exclude node_modules --exclude .env --exclude uploads --exclude 'web/dist' \
  --exclude .git ./ "$SSH:$APP_DIR/"
rsync -az web/dist/assets/ "$SSH:$APP_DIR/web/dist/assets/"
rsync -az --delete --exclude assets web/dist/ "$SSH:$APP_DIR/web/dist/"

ssh "$SSH" "cd $APP_DIR && npm ci --omit=dev -w server --include-workspace-root=false >/dev/null \
  && docker compose --env-file .env up -d search >/dev/null 2>&1 \
  && (cd server && node --env-file=../.env src/migrate.js) && sudo systemctl restart seferehov"
echo "Deployed $(cat web/dist/version.json)"
