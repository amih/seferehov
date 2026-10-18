import { config } from './config.js';
import { one, q } from './db.js';
import { randomToken, sha256 } from './util.js';
import { sendMail } from './mail.js';
import { authUrl, exchangeCode } from './google.js';
import { readForm } from './multipart.js';
import { saveAvatar, fetchGoogleAvatar, removeUpload, avatarUrl } from './photos.js';

const SESSION_COOKIE = 'seferehov_session';
const STATE_COOKIE = 'seferehov_oauth_state';
const SESSION_DAYS = 180;
const LOGIN_TOKEN_MINUTES = 20;
const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);
const googleRedirect = () => `${config.baseUrl}/api/auth/google/callback`;

// Letters in any script, digits, space, _ . - ; 3–30 characters.
const SCREEN_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,28}[\p{L}\p{N}]$/u;

export async function currentUser(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return one(
    `SELECT u.id, u.email, u.screen_name, u.trust_level, u.avatar_path, u.avatar_source,
            u.google_sub IS NOT NULL AS has_google, u.google_picture, u.notify_email, u.notify_push
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
}

export function requireUser(minTrust = 0) {
  return async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'login_required' });
    if (req.user.trust_level < minTrust) return reply.code(403).send({ error: 'forbidden' });
  };
}

const cookieOpts = (maxAge) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: config.baseUrl.startsWith('https://'),
  maxAge,
});

async function startSession(reply, userId) {
  const session = randomToken();
  await q(
    `INSERT INTO sessions(token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(session), userId, SESSION_DAYS],
  );
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  reply.setCookie(SESSION_COOKIE, session, cookieOpts(SESSION_DAYS * 86400));
}

const initialTrust = (email) => (config.adminEmails.includes(email) ? 3 : 0);

// A Google account is matched by its stable id first, then by email, so a
// person who first signed in by email link ends up with one account.
export async function userFromGoogle(g, log) {
  let user = await one('SELECT id, avatar_path, avatar_source FROM users WHERE google_sub = $1', [g.sub])
    ?? await one('SELECT id, avatar_path, avatar_source FROM users WHERE email = $1', [g.email]);
  if (user) {
    await q(
      `UPDATE users SET google_sub = $2, google_picture = $3,
              trust_level = GREATEST(trust_level, $4) WHERE id = $1`,
      [user.id, g.sub, g.picture, initialTrust(g.email)],
    );
  } else {
    user = await one(
      `INSERT INTO users(email, google_sub, google_picture, trust_level) VALUES ($1, $2, $3, $4)
       RETURNING id, avatar_path, avatar_source`,
      [g.email, g.sub, g.picture, initialTrust(g.email)],
    );
  }
  // Keep the Google picture in step, unless the user uploaded their own.
  if (g.picture && user.avatar_source !== 'upload') {
    try {
      const rel = await fetchGoogleAvatar(g.picture, user.id);
      await q(`UPDATE users SET avatar_path = $2, avatar_source = 'google' WHERE id = $1`, [user.id, rel]);
      await removeUpload(user.avatar_path);
    } catch (err) {
      log.warn({ err }, 'could not copy Google avatar');
    }
  }
  return user;
}

export default async function authRoutes(app) {
  app.get('/api/auth/config', async () => ({ google: googleEnabled() }));

  // ---- one-time email link ----------------------------------------------
  app.post('/api/auth/request', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return reply.code(400).send({ error: 'invalid_email' });
    }
    const token = randomToken();
    await q(
      `INSERT INTO login_tokens(token_hash, email, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [sha256(token), email, LOGIN_TOKEN_MINUTES],
    );
    const link = `${config.baseUrl}/api/auth/verify?t=${token}`;
    const mail = req.body?.lang === 'en'
      ? {
          subject: 'Your Seferehov sign-in link',
          text: `Tap to sign in to Seferehov:\n\n${link}\n\nThe link works once and expires in ${LOGIN_TOKEN_MINUTES} minutes.\nIf you did not ask for it, ignore this email.`,
        }
      : {
          subject: 'קישור הכניסה שלך לספרחוב',
          text: `לכניסה לספרחוב הקישו על הקישור:\n\n${link}\n\nהקישור עובד פעם אחת, ותוקפו ${LOGIN_TOKEN_MINUTES} דקות.\nאם לא ביקשתם אותו, אפשר להתעלם מהמייל הזה.`,
        };
    await sendMail({ to: email, ...mail }, req.log);
    return { ok: true };
  });

  app.get('/api/auth/verify', async (req, reply) => {
    const token = String(req.query.t ?? '');
    const row = token && await one(
      `UPDATE login_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING email`,
      [sha256(token)],
    );
    if (!row) return reply.redirect('/login?error=expired');
    const user = await one(
      `INSERT INTO users(email, trust_level) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET trust_level = GREATEST(users.trust_level, EXCLUDED.trust_level)
       RETURNING id`,
      [row.email, initialTrust(row.email)],
    );
    await startSession(reply, user.id);
    return reply.redirect('/me?welcome=1');
  });

  // ---- Google (redirect flow: nothing for ad blockers to break) ----------
  app.get('/api/auth/google', async (req, reply) => {
    if (!googleEnabled()) return reply.redirect('/login?error=google_off');
    const state = randomToken();
    reply.setCookie(STATE_COOKIE, state, cookieOpts(600));
    return reply.redirect(authUrl({ clientId: config.google.clientId, redirectUri: googleRedirect(), state }));
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const expected = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/' });
    if (req.query.error) return reply.redirect('/login');
    if (!expected || expected !== req.query.state) return reply.redirect('/login?error=expired');
    try {
      const g = await exchangeCode({
        code: String(req.query.code ?? ''),
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: googleRedirect(),
      });
      const user = await userFromGoogle(g, req.log);
      await startSession(reply, user.id);
      return reply.redirect('/me?welcome=1');
    } catch (err) {
      req.log.warn({ err }, 'google sign-in failed');
      return reply.redirect('/login?error=google');
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- profile ------------------------------------------------------------
  app.get('/api/me', async (req) => {
    if (!req.user) return { user: null };
    const u = req.user;
    const stats = await one(
      `SELECT COALESCE((SELECT sum(points) FROM karma_events WHERE user_id = $1), 0)::int AS karma,
              (SELECT count(*) FROM locations WHERE created_by = $1 AND status = 'approved')::int AS locations,
              (SELECT count(*) FROM sightings WHERE user_id = $1 AND status = 'approved')::int AS sightings`,
      [u.id],
    );
    return {
      user: {
        id: u.id, email: u.email, screen_name: u.screen_name, trust_level: u.trust_level,
        avatar: avatarUrl(u.avatar_path), avatar_source: u.avatar_source,
        has_google: u.has_google, can_use_google_picture: Boolean(u.google_picture),
        notify_email: u.notify_email, notify_push: u.notify_push,
        ...stats,
      },
    };
  });

  app.post('/api/me', { preHandler: requireUser() }, async (req, reply) => {
    const name = String(req.body?.screen_name ?? '').trim().replace(/\s+/g, ' ');
    if (!SCREEN_NAME_RE.test(name) || name.includes('@')) {
      return reply.code(400).send({ error: 'invalid_screen_name' });
    }
    try {
      await q('UPDATE users SET screen_name = $1 WHERE id = $2', [name, req.user.id]);
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'screen_name_taken' });
      throw err;
    }
    return { ok: true, screen_name: name };
  });

  app.post('/api/me/avatar', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { files } = await readForm(req);
    if (!files.avatar) return reply.code(400).send({ error: 'no_image' });
    let rel;
    try { rel = await saveAvatar(files.avatar, req.user.id); } catch { return reply.code(400).send({ error: 'bad_image' }); }
    await q(`UPDATE users SET avatar_path = $2, avatar_source = 'upload' WHERE id = $1`, [req.user.id, rel]);
    await removeUpload(req.user.avatar_path);
    return { avatar: avatarUrl(rel) };
  });

  // Remove an uploaded picture: back to the Google one if there is one, else none.
  app.delete('/api/me/avatar', { preHandler: requireUser() }, async (req) => {
    let rel = null;
    if (req.user.google_picture) {
      try { rel = await fetchGoogleAvatar(req.user.google_picture, req.user.id); } catch { rel = null; }
    }
    await q('UPDATE users SET avatar_path = $2, avatar_source = $3 WHERE id = $1',
      [req.user.id, rel, rel ? 'google' : null]);
    await removeUpload(req.user.avatar_path);
    return { avatar: avatarUrl(rel) };
  });
}
