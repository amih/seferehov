# ספרחוב · Seferehov

Runs at **https://seferehov.com**.

A shared map of free street libraries (book boxes, little free libraries, shelves in lobbies and parks) and the books on their shelves right now. Installable as an app on any phone (PWA).

- **Add a library**: GPS position, a photo, and a hint for finding it.
- **Add books**: scan the barcode on the back cover; details come from Open Library / Google Books. Books without a barcode can be typed in.
- **Photograph the shelf**: a few photos or a short video of the spines/covers. The server picks sharp, distinct video frames (ffmpeg), reads ISBN barcodes (ZXing) and titles (local vision model via Ollama, default `qwen3-vl:8b-instruct`), looks them up, and the user ticks/corrects the list before anything is saved.
- **Seen, left, taken**: report a book on the shelf, a book you left, or a book you took — all optional.
- **Local book catalogue**: the Open Library monthly dump (CC0, ~40M editions) is imported into `ol_books` by `deploy/ol-refresh.sh` (systemd timer `deploy/seferehov-ol-refresh.*`, 5th of each month), so ISBN and title lookups are local. Web APIs (Open Library, Google Books with `GOOGLE_BOOKS_API_KEY`, National Library of Israel with `NLI_API_KEY`) are fallbacks.
- **Search statistics**: every catalogue search is logged in `lookups` (query, which source answered, match score) and every request to a source in `lookup_calls` (hit / miss / error / limited, HTTP status, retries, time). When a user confirms a shelf scan, each item is marked kept / edited / dropped, so you can see which source gives right answers. A source that reports its quota used up is skipped for an hour. Summaries: `SELECT * FROM lookup_source_daily` and `SELECT * FROM lookup_match_quality`.
- **Private-info check**: library names, hints and notes are checked for door codes, phone numbers and e-mails (patterns + the local model) before they are published.
- **Library changes**: anyone can suggest a new name, hint, photo, position or "it's gone". With `REVIEW_ALL_LOCATIONS=1` (default) every new library and change waits for a reviewer; admins get an email digest (`NOTIFY_ADMIN_MINUTES`).
- **Books come and go**: the app stores *sightings* (seen / taken / not there), so every shelf shows what was last seen and when.
- **Points and trust**: every approved report earns points. New users' reports go to a review queue; after a few approved ones they publish directly. Reports from far away from the library always go to review.
- **Works offline**: photos and scans made without signal upload later.
- **Printable sign** per library (A5, QR code linking to `/l/<code>`).
- Seeded with every `amenity=public_bookcase` from OpenStreetMap.

## Stack

| | |
|---|---|
| Web | Vite, vanilla JS, Leaflet + MapLibre vector map (OpenFreeMap, recoloured), Workbox service worker, ZXing WASM barcode reader. Hebrew (default, RTL) and English — strings in `web/src/i18n.js` |
| API | Node 22, Fastify 5, sharp (photos are re-encoded, which removes EXIF/GPS metadata) |
| DB | PostgreSQL 16 + PostGIS (Docker) |

## Run locally

```bash
cp .env.example .env          # set ADMIN_EMAILS to your email
npm install
npm run db:up && npm run migrate
npm run seed:osm -- 29.4,34.2,33.4,35.9   # bbox south,west,north,east; omit for the whole world
npm run dev:server            # API on :3870 (sign-in links are printed to this log without SMTP)
npm run dev:web               # app on :5173
```

## Production

One home server runs everything: nginx, the API (systemd `seferehov`, port 3870), PostGIS in Docker, Ollama, and the monthly catalogue refresh (`seferehov-ol-refresh.timer`).

- **Deploy**: `deploy/deploy.sh` — refuses a dirty tree, builds, rsyncs to `APP_DIR` on the server (from gitignored `deploy/target.private`: `SSH=user@host APP_DIR=/path`), runs migrations, restarts `seferehov`.
- **First install**: copy `deploy/seferehov.service`, `deploy/seferehov-ocr.service` (Surya OCR for Hebrew cover texts; venv steps in the file) and `deploy/seferehov-ol-refresh.{service,timer}` to `/etc/systemd/system/` (replace `APP_USER`/`APP_DIR`), and `deploy/nginx.conf` to `/etc/nginx/sites-available/` (replace `HOST`, `APP_DIR`).
- **Server `.env`**: `BASE_URL=https://seferehov.com`, SMTP (`noreply@seferehov.com`), Google sign-in, `NLI_API_KEY`, `ADMIN_EMAILS`. Google sign-in needs `BASE_URL/api/auth/google/callback` listed as a redirect URI in the Google Cloud console.

## How updates reach installed apps

No version numbers to bump. Each build:

1. emits content-hashed asset names and a precache list (vite-plugin-pwa, `injectManifest`);
2. writes `version.json` (`<date>.<time>-<git sha>`), which the API echoes as `X-App-Version`.

The app checks for a new service worker on start, when it comes back to the foreground, hourly, and whenever the API reports a different version. The new worker installs in the background and is switched in at a safe moment: on the next screen change, or when the app is in the background, and never while uploads are queued. After the reload a toast shows the new version. For breaking API changes, set `MIN_CLIENT_BUILD` on the server: older clients get HTTP 426 and update immediately.

Server cache rules (see `deploy/nginx.conf`): `/assets/*` immutable for a year; `index.html`, `sw.js`, `version.json`, `manifest.webmanifest` always revalidated.

## Data and licences

Code: AGPL-3.0-or-later. Library locations include OpenStreetMap data © OpenStreetMap contributors, ODbL.
