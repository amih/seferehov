import { resolve } from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3870),
  host: env.HOST || '127.0.0.1',
  baseUrl: (env.BASE_URL || 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://seferehov:seferehov@127.0.0.1:5470/seferehov',
  uploadDir: resolve(env.UPLOAD_DIR || './uploads'),
  webDist: resolve(env.WEB_DIST || '../web/dist'),
  adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  minClientBuild: Number(env.MIN_CLIENT_BUILD || 0),
  // National Library of Israel search API key (free: https://api2.nli.org.il). Optional.
  nliApiKey: env.NLI_API_KEY || '',
  // Google Books API key (free, 1000 lookups/day). Optional but the keyless quota runs out.
  googleBooksKey: env.GOOGLE_BOOKS_API_KEY || '',
  trustThreshold: Number(env.TRUST_THRESHOLD || 5),
  // 1 = every new library and every library change waits for a reviewer (admins excepted).
  reviewAllLocations: (env.REVIEW_ALL_LOCATIONS ?? '1') === '1',
  // Admins get one email per this many minutes when something waits for review. 0 = off.
  notifyAdminMinutes: Number(env.NOTIFY_ADMIN_MINUTES ?? 10),
  vision: {
    url: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: env.VISION_MODEL || 'qwen3-vl:8b-instruct',
  },
  // Surya OCR service (ocr/surya_server.py) for Hebrew cover text.
  ocrUrl: (env.OCR_URL || 'http://127.0.0.1:3872').replace(/\/$/, ''),
  // Checks public texts for door codes, phone numbers etc. Same model = no GPU swap.
  privacyModel: env.PRIVACY_MODEL || env.VISION_MODEL || 'qwen3-vl:8b-instruct',
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Seferehov <noreply@example.com>',
  },
  // Visitor numbers on /admin: a view-only Matomo token for the Seferehov site. Optional.
  matomo: {
    url: (env.MATOMO_URL || '').replace(/\/$/, ''),
    siteId: env.MATOMO_SITE_ID || '',
    token: env.MATOMO_TOKEN || '',
  },
  // Phone notifications (Web Push): npx web-push generate-vapid-keys. Optional.
  vapid: {
    publicKey: env.VAPID_PUBLIC || '',
    privateKey: env.VAPID_PRIVATE || '',
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  // Sightings reported from farther than this go to review even for trusted users.
  maxReportDistanceM: 300,
};

// Karma. Generous at the start on purpose: a reader reaches the second level on the
// first day with one full shelf. Levels are in levels.js.
export const POINTS = {
  location: 100, // a new library
  sighting: 10, // a book on a shelf, or left there
  taken: 10, // "I took it"
  gone: 50, // a book that is no longer there: keeps the map honest
  check: 50, // the library's state, standing by it (once a day per library)
  shelf: 150, // three or more books reported at one library (once a day per library)
  edit: 20, // a change to a library, once approved
  review: 10, // a reviewer's decision
  bookReview: 30, // a written review of a book (once per book)
};
export const KARMA_DAY_CAP = 1000;
