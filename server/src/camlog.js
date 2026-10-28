// Live-camera sessions from readers' phones (web/src/camlog.js): numbers only, to tune
// the shelf camera. The admin sees them at /admin#camera. Older than a year: deleted.
import { many, q } from './db.js';
import { requireUser } from './auth.js';

const KINDS = new Set(['shelf', 'covers', 'stack']);

export default async function cameraLogRoutes(app) {
  app.post('/api/camera-log', { bodyLimit: 32 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
    if (!KINDS.has(b.kind) || typeof b.stats !== 'object' || !b.stats) return reply.code(400).send({ error: 'bad_request' });
    await q('INSERT INTO camera_sessions (user_id, kind, ua, stats) VALUES ($1, $2, $3, $4)',
      [req.user?.id ?? null, b.kind, String(req.headers['user-agent'] ?? '').slice(0, 200), b.stats]);
    q(`DELETE FROM camera_sessions WHERE created_at < now() - interval '1 year'`).catch(() => {});
    return { ok: true };
  });

  app.get('/api/admin/camera-sessions', { preHandler: requireUser(3) }, async () => ({
    sessions: await many(
      `SELECT c.id, c.kind, c.ua, c.stats, c.created_at, u.id AS user_id, u.screen_name
         FROM camera_sessions c LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC LIMIT 100`),
  }));
}
