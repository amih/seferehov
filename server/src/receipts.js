// Store and forward, the server's half: the phone sends every upload from its outbox
// (web/src/queue.js) with an id in X-Upload-Id, and sends it again until it gets an
// answer. When the first one arrived but its answer was lost, the repeat gets that
// first answer back (and nothing is saved twice). Only successful answers are kept.
// Every try (any answer) also goes to upload_timings with what the phone said about it
// (X-Upload-Timing: waited on the phone, size, tries, network, camera session) and how
// long the server took; the phone then reports how long the whole upload took
// (POST /api/upload-timing). For later analysis of the cameras and the street signal.
import { one, q } from './db.js';

const ID = /^[\w-]{6,80}$/;
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : null);
function readTiming(req) {
  try {
    const t = JSON.parse(decodeURIComponent(String(req.headers['x-upload-timing'] ?? '')));
    return t && typeof t === 'object' ? t : null;
  } catch { return null; }
}
// What the upload became (for matching it with the scan or the book later).
const resultOf = (body, status) => body && typeof body === 'object'
  ? { scan: body.scan?.id ?? null, book: body.book?.id ?? null, sighting: body.sighting?.id ?? null, error: status >= 300 ? str(body.error) : null }
  : null;

export function uploadReceipts(app) {
  app.addHook('preHandler', async (req, reply) => {
    const id = req.headers['x-upload-id'];
    if (req.method !== 'POST' || !id || !ID.test(id)) return;
    const seen = await one(`SELECT status, body FROM upload_receipts WHERE id = $1 AND created_at > now() - interval '14 days'`, [id]);
    if (seen) return reply.code(seen.status).header('X-Upload-Replay', '1').send(seen.body ?? {});
    req.uploadId = id;
    req.uploadStart = performance.now();
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.uploadId || reply.getHeader('X-Upload-Replay')) return payload;
    let body = null;
    try { body = typeof payload === 'string' ? JSON.parse(payload) : null; } catch {}
    const t = readTiming(req);
    if (t) {
      q(`INSERT INTO upload_timings (id, user_id, cam_session, label, path, status, bytes, files, tries, sender, net, queued_ms, held_ms, server_ms, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, tries = EXCLUDED.tries, net = EXCLUDED.net, sender = EXCLUDED.sender,
           queued_ms = EXCLUDED.queued_ms, held_ms = EXCLUDED.held_ms, server_ms = EXCLUDED.server_ms, result = EXCLUDED.result, client_ms = NULL, created_at = now()`,
        [req.uploadId, req.user?.id ?? null, str(t.session), str(t.label, 40), req.routeOptions?.url ?? req.url.split('?')[0], reply.statusCode,
          num(t.bytes), num(t.files), num(t.tries), str(t.by, 8), str(t.net, 40),
          num(t.sentAt) != null && num(t.created) != null ? num(t.sentAt) - num(t.created) : null,
          num(t.sentAt) != null && num(t.held) != null ? num(t.sentAt) - num(t.held) : null,
          Math.round(performance.now() - req.uploadStart), resultOf(body, reply.statusCode)])
        .catch((err) => req.log.warn({ err }, 'upload timing'));
    }
    if (reply.statusCode >= 300) return payload;
    await q('INSERT INTO upload_receipts (id, user_id, status, body) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [req.uploadId, req.user?.id ?? null, reply.statusCode, body]).catch((err) => req.log.warn({ err }, 'upload receipt'));
    if (Math.random() < 0.01) {
      q(`DELETE FROM upload_receipts WHERE created_at < now() - interval '14 days'`).catch(() => {});
      q(`DELETE FROM upload_timings WHERE created_at < now() - interval '1 year'`).catch(() => {});
    }
    return payload;
  });
  // The phone: how long this upload took, sent → answer.
  app.post('/api/upload-timing', { bodyLimit: 1024, config: { rateLimit: { max: 600, timeWindow: '1 hour' } } }, async (req) => {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
    const ms = num(b.ms);
    if (!ID.test(String(b.id ?? '')) || ms == null || ms < 0 || ms > 3_600_000) return { ok: false };
    await q('UPDATE upload_timings SET client_ms = $2 WHERE id = $1 AND user_id IS NOT DISTINCT FROM $3', [b.id, ms, req.user?.id ?? null]);
    return { ok: true };
  });
}
