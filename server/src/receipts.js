// Store and forward, the server's half: the phone sends every upload from its outbox
// (web/src/queue.js) with an id in X-Upload-Id, and sends it again until it gets an
// answer. When the first one arrived but its answer was lost, the repeat gets that
// first answer back (and nothing is saved twice). Only successful answers are kept.
import { one, q } from './db.js';

const ID = /^[\w-]{6,80}$/;

export function uploadReceipts(app) {
  app.addHook('preHandler', async (req, reply) => {
    const id = req.headers['x-upload-id'];
    if (req.method !== 'POST' || !id || !ID.test(id)) return;
    const seen = await one(`SELECT status, body FROM upload_receipts WHERE id = $1 AND created_at > now() - interval '14 days'`, [id]);
    if (seen) return reply.code(seen.status).header('X-Upload-Replay', '1').send(seen.body ?? {});
    req.uploadId = id;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.uploadId || reply.statusCode >= 300 || reply.getHeader('X-Upload-Replay')) return payload;
    let body = null;
    try { body = typeof payload === 'string' ? JSON.parse(payload) : null; } catch {}
    await q('INSERT INTO upload_receipts (id, user_id, status, body) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [req.uploadId, req.user?.id ?? null, reply.statusCode, body]).catch((err) => req.log.warn({ err }, 'upload receipt'));
    if (Math.random() < 0.01) q(`DELETE FROM upload_receipts WHERE created_at < now() - interval '14 days'`).catch(() => {});
    return payload;
  });
}
