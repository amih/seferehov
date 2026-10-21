# ספרחוב (Seferehov)

- App name: ספרחוב in Hebrew, Seferehov in English. Production is https://seferehov.com. Never call the app POFOV (its first name).

- Never bump versions by hand: the build derives the version from time + git sha. Commit before deploying (`deploy/deploy.sh` refuses a dirty tree).
- Real hostnames, IPs, and SSH targets go only in gitignored `*.private` / `*.private.md` files (this repo is public).
- Deploy: `deploy/deploy.sh` (reads `deploy/target.private`).
- `zxing-wasm` in web/package.json must be the exact version `barcode-detector` depends on, or the WASM binary won't match its JS glue ("Failed to allocate … in WASM memory").
- Local end-to-end testing: `SERVE_WEB=1 BASE_URL=http://localhost:3870 node --env-file=../.env src/index.js` in server/ serves the built app with production cache headers. `vite preview` caches files at startup and can't test updates.
- Features doc: `docs/FEATURES.md` describes every feature, the hardware, capacity, disk and backups, and future plans. Update it in the same commit as any feature change (add, change or remove), then rebuild the PDF with `docs/build-pdf.sh` and commit `docs/FEATURES.pdf` too. Move items from "Future plans" into the feature sections when they ship.
