// Live-camera sessions from readers' phones (web/src/camlog.js): numbers only (the phone,
// its system, browser and camera; how long each photo, book and barcode took), to tune
// the cameras. The admin sees them at /admin#camera. Older than a year: deleted.
import { many, q } from './db.js';
import { requireUser } from './auth.js';

const KINDS = new Set(['shelf', 'covers', 'stack', 'barcode']);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

export default async function cameraLogRoutes(app) {
  app.post('/api/camera-log', { bodyLimit: 256 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
    if (!KINDS.has(b.kind) || typeof b.stats !== 'object' || !b.stats) return reply.code(400).send({ error: 'bad_request' });
    await q('INSERT INTO camera_sessions (user_id, kind, ua, stats, sid, device, camera) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.user?.id ?? null, b.kind, String(req.headers['user-agent'] ?? '').slice(0, 300), b.stats,
        typeof b.sid === 'string' ? b.sid.slice(0, 60) : null, obj(b.device), obj(b.camera)]);
    q(`DELETE FROM camera_sessions WHERE created_at < now() - interval '1 year'`).catch(() => {});
    return { ok: true };
  });

  app.get('/api/admin/camera-sessions', { preHandler: requireUser(3) }, async () => ({
    sessions: await many(
      `SELECT c.id, c.kind, c.ua, c.stats, c.sid, c.device, c.camera, c.created_at, u.id AS user_id, u.screen_name
         FROM camera_sessions c LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC LIMIT 100`),
    uploads: await many(
      `SELECT t.id, t.cam_session, t.label, t.path, t.status, t.bytes, t.files, t.tries, t.sender, t.net,
              t.queued_ms, t.held_ms, t.client_ms, t.server_ms, t.result, t.created_at, u.screen_name
         FROM upload_timings t LEFT JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC LIMIT 100`),
  }));
}
