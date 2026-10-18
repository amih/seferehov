import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import authRoutes, { currentUser } from './auth.js';
import locationRoutes from './locations.js';
import reviewRoutes from './review.js';
import signRoutes from './sign.js';
import editRoutes from './edits.js';
import scanRoutes, { startScanWorker } from './scans.js';
import approvalRoutes from './approvals.js';
import myBookRoutes from './mybooks.js';
import duplicateRoutes from './duplicates.js';
import { startAdminNotifier } from './notify.js';
import seoRoutes, { renderShell } from './seo.js';
import finderRoutes, { startWatchNotifier } from './finder.js';
import adminRoutes from './admin.js';
import bookReviewRoutes from './reviews.js';
import { startOcrWorker } from './ocr.js';

const app = Fastify({ logger: true, trustProxy: '127.0.0.1', bodyLimit: 1024 * 1024 });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 4, fields: 20 } });
await app.register(rateLimit, { global: false });

// The web build writes version.json; the API echoes it so open clients notice a deploy.
function webVersion() {
  try { return JSON.parse(readFileSync(join(config.webDist, 'version.json'), 'utf8')); } catch { return null; }
}
let deployed = webVersion();
setInterval(() => { deployed = webVersion(); }, 30_000).unref();

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  if (deployed) reply.header('X-App-Version', deployed.version);
  const build = Number(req.headers['x-app-build']);
  if (config.minClientBuild && Number.isFinite(build) && build < config.minClientBuild) {
    return reply.code(426).send({ error: 'update_required' });
  }
  req.user = await currentUser(req);
});

await app.register(authRoutes);
await app.register(locationRoutes);
await app.register(reviewRoutes);
await app.register(signRoutes);
await app.register(editRoutes);
await app.register(scanRoutes);
await app.register(approvalRoutes);
await app.register(myBookRoutes);
await app.register(duplicateRoutes);
await app.register(seoRoutes);
await app.register(finderRoutes);
await app.register(adminRoutes);
await app.register(bookReviewRoutes);

app.get('/api/health', async () => ({ ok: true, web: deployed?.version ?? null }));

// In production nginx serves /uploads and the files of the web build, and sends every
// other page here (see deploy/nginx.conf). SERVE_WEB=1 makes this process serve the files too.
await app.register(fastifyStatic, { root: config.uploadDir, prefix: '/uploads/', decorateReply: false });
if (process.env.SERVE_WEB === '1') {
  await app.register(fastifyStatic, {
    root: config.webDist,
    prefix: '/',
    index: false,
    wildcard: false,
    cacheControl: false,
    setHeaders(reply, path) {
      reply.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
// Any other page: the app shell, with search-engine content for the pages that have it.
app.setNotFoundHandler(async (req, reply) => {
  if (!['GET', 'HEAD'].includes(req.method) || req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const { status, html } = await renderShell(req);
  return reply.code(status).header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
});

await app.listen({ port: config.port, host: config.host });
startScanWorker(app.log);
startAdminNotifier(app.log);
startWatchNotifier(app.log);
startOcrWorker(app.log);
