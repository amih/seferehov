// Phone notifications (Web Push). The browser gives us an address per device; we send
// to it with our VAPID key pair (VAPID_PUBLIC / VAPID_PRIVATE in .env). An address the
// push service no longer knows (the reader turned notifications off, or the app was
// removed) answers 404/410 and is deleted.
import webpush from 'web-push';
import { config } from './config.js';
import { many, q } from './db.js';
import { requireUser } from './auth.js';

const ready = !!(config.vapid.publicKey && config.vapid.privateKey);
if (ready) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

// payload: { title, body, url }. Resolves to how many devices got it.
export async function sendPush(userId, payload, log = console) {
  if (!ready) return 0;
  const subs = await many('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = $1', [userId]);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await q('DELETE FROM push_subs WHERE id = $1', [s.id]);
      else log.warn?.({ err: err.message, status: err.statusCode }, 'push failed');
    }
  }
  return sent;
}

export default async function pushRoutes(app) {
  app.get('/api/push/key', async () => ({ key: ready ? config.vapid.publicKey : null }));

  app.post('/api/push', { preHandler: requireUser(), config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    await q(
      `INSERT INTO push_subs(user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100)]);
    return { ok: true };
  });

  app.delete('/api/push', { preHandler: requireUser() }, async (req) => {
    await q('DELETE FROM push_subs WHERE user_id = $1 AND endpoint = $2', [req.user.id, String(req.body?.endpoint ?? '')]);
    return { ok: true };
  });

  // Email and phone notifications on/off.
  app.post('/api/me/notify', { preHandler: requireUser() }, async (req) => {
    const { email, push } = req.body ?? {};
    await q('UPDATE users SET notify_email = COALESCE($2, notify_email), notify_push = COALESCE($3, notify_push) WHERE id = $1',
      [req.user.id, typeof email === 'boolean' ? email : null, typeof push === 'boolean' ? push : null]);
    return { ok: true };
  });
}
