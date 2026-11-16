// Inviting friends (16 Nov 2026). Every link is https://<site>/?i=<code>.
//   - A plain invite: the reader's own link, the same every time. Whoever signs up through
//     it is counted as theirs (users.invited_by).
//   - A handover: the books a reader catalogued at a friend's home (my_books.owner =
//     'friend', by friend_name) go with the link. The friend opens it, sees who sent it and
//     the books (titles and covers only), signs in, and accepts them into their own My
//     books (private, like any home book) or declines. Once, within 60 days.
// The inviter gets points once, at the new reader's first contribution or their accepting
// the books (moderation.js rewardInviter). No limits on invites, and no invite-only gate.
import { randomBytes } from 'node:crypto';
import { one, many, q, tx } from './db.js';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { rewardInviter } from './moderation.js';

const HANDOVER_DAYS = 60;
export const inviteCode = () => randomBytes(9).toString('base64url'); // 12 characters
export const inviteLink = (code) => `${config.baseUrl}/?i=${code}`;
export const validCode = (code) => /^[A-Za-z0-9_-]{8,32}$/.test(String(code ?? ''));

// The friend's books a reader still has, grouped by the name they gave the friend.
const FRIENDS_SQL = `
  SELECT coalesce(m.friend_name, '') AS friend_name, count(*)::int AS n, array_agg(m.id ORDER BY m.id) AS ids
    FROM my_books m WHERE m.user_id = $1 AND m.owner = 'friend' AND m.placed_at IS NULL
   GROUP BY 1 ORDER BY max(m.created_at) DESC`;

// The books going with a handover link, as the friend sees them: titles, authors, covers.
const HANDOVER_BOOKS_SQL = `
  SELECT m.id, b.title, b.authors, p.thumb_path, COALESCE(b.front_url, b.cover_url) AS cover_url
    FROM invite_books ib JOIN my_books m ON m.id = ib.my_book_id JOIN books b ON b.id = m.book_id
    LEFT JOIN photos p ON p.id = m.photo_id
   WHERE ib.invite_id = $1 AND m.owner = 'friend' AND m.placed_at IS NULL
   ORDER BY b.title`;

export function inviteState(inv, now = new Date()) {
  if (inv.accepted_at) return 'accepted';
  if (inv.declined_at) return 'declined';
  if (inv.expires_at && new Date(inv.expires_at) < now) return 'expired';
  return 'open';
}

async function plainInvite(userId) {
  const had = await one('SELECT code FROM invites WHERE user_id = $1 AND NOT handover', [userId]);
  if (had) return had.code;
  const row = await one(
    `INSERT INTO invites(code, user_id) VALUES ($1, $2) ON CONFLICT (user_id) WHERE NOT handover DO NOTHING RETURNING code`,
    [inviteCode(), userId]);
  return row?.code ?? (await one('SELECT code FROM invites WHERE user_id = $1 AND NOT handover', [userId])).code;
}

// Counted as the inviter's only when the account is new: made after the link was.
async function join(user, inv) {
  if (inv.user_id === user.id) return false;
  const r = await q(
    `UPDATE users SET invited_by = $2, invite_id = $3 WHERE id = $1 AND invited_by IS NULL AND created_at >= $4`,
    [user.id, inv.user_id, inv.id, inv.created_at]);
  return r.rowCount > 0;
}

export default async function inviteRoutes(app) {
  // My own invite link, and the friends whose books I catalogued (each can be sent theirs).
  app.get('/api/invites', { preHandler: requireUser() }, async (req) => {
    const code = await plainInvite(req.user.id);
    const friends = await many(FRIENDS_SQL, [req.user.id]);
    const joined = await one('SELECT count(*)::int AS n FROM users WHERE invited_by = $1', [req.user.id]);
    return { link: inviteLink(code), joined: joined.n, friends: friends.map(({ ids, ...f }) => f) };
  });

  // A handover link for one friend's books (by the name the reader gave the friend).
  app.post('/api/invites/handover', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const name = String(req.body?.friend_name ?? '').trim();
    const group = (await many(FRIENDS_SQL, [req.user.id])).find((f) => f.friend_name === name);
    if (!group) return reply.code(404).send({ error: 'no_books' });
    const code = inviteCode();
    await tx(async (db) => {
      const inv = (await db.query(
        `INSERT INTO invites(code, user_id, handover, friend_name, expires_at) VALUES ($1, $2, true, $3, now() + make_interval(days => $4)) RETURNING id`,
        [code, req.user.id, name || null, HANDOVER_DAYS])).rows[0];
      await db.query('INSERT INTO invite_books(invite_id, my_book_id) SELECT $1, unnest($2::bigint[])', [inv.id, group.ids]);
    });
    return { link: inviteLink(code), n: group.n, friend_name: name || null };
  });

  // What the link shows: who sent it, and the books if it is a handover. Anyone may look.
  app.get('/api/invites/:code', async (req, reply) => {
    if (!validCode(req.params.code)) return reply.code(404).send({ error: 'not_found' });
    const inv = await one(
      `SELECT i.*, u.screen_name FROM invites i JOIN users u ON u.id = i.user_id WHERE i.code = $1`, [req.params.code]);
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    const books = inv.handover ? await many(HANDOVER_BOOKS_SQL, [inv.id]) : [];
    return {
      from: inv.screen_name, handover: inv.handover, friend_name: inv.friend_name, state: inviteState(inv),
      own: req.user?.id === inv.user_id, accepted_by_me: !!req.user && inv.accepted_by === req.user.id,
      books: books.map(({ thumb_path, ...b }) => ({ ...b, cover: thumb_path ? `/uploads/${thumb_path}` : b.cover_url ?? null })),
    };
  });

  // A signed-in reader came through the link (the app calls this once after signing in).
  app.post('/api/invites/:code/join', { preHandler: requireUser() }, async (req, reply) => {
    const inv = validCode(req.params.code) && await one('SELECT * FROM invites WHERE code = $1', [req.params.code]);
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    return { joined: await join(req.user, inv) };
  });

  // The friend takes the books: they move to the friend's own My books, private.
  app.post('/api/invites/:code/accept', { preHandler: requireUser() }, async (req, reply) => {
    const inv = validCode(req.params.code) && await one('SELECT * FROM invites WHERE code = $1 AND handover', [req.params.code]);
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (inv.user_id === req.user.id) return reply.code(400).send({ error: 'own_invite' });
    if (inviteState(inv) !== 'open') return reply.code(409).send({ error: inviteState(inv) });
    await join(req.user, inv);
    const moved = await tx(async (db) => {
      const done = await db.query(
        `UPDATE invites SET accepted_by = $2, accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND declined_at IS NULL`, [inv.id, req.user.id]);
      if (!done.rowCount) return null;
      const r = await db.query(
        `UPDATE my_books m SET user_id = $3, owner = 'mine', friend_name = NULL, public = false, public_at = NULL,
                offer = NULL, price = NULL, condition = NULL, offer_note = NULL, offered_at = NULL, offer_place_id = NULL
           FROM invite_books ib
          WHERE ib.invite_id = $1 AND ib.my_book_id = m.id AND m.user_id = $2 AND m.owner = 'friend' AND m.placed_at IS NULL`,
        [inv.id, inv.user_id, req.user.id]);
      // The inviter's queue no longer adds to those books (they are the friend's now).
      await db.query('UPDATE scan_items SET my_book_id = NULL WHERE my_book_id IN (SELECT my_book_id FROM invite_books WHERE invite_id = $1)', [inv.id]);
      await db.query(`UPDATE users SET invited_by = COALESCE(invited_by, $2) WHERE id = $1 AND id <> $2`, [req.user.id, inv.user_id]);
      await rewardInviter(db, req.user.id);
      return r.rowCount;
    });
    if (moved === null) return reply.code(409).send({ error: 'accepted' });
    return { moved };
  });

  app.post('/api/invites/:code/decline', { preHandler: requireUser() }, async (req, reply) => {
    const inv = validCode(req.params.code) && await one('SELECT * FROM invites WHERE code = $1 AND handover', [req.params.code]);
    if (!inv || inv.user_id === req.user.id) return reply.code(404).send({ error: 'not_found' });
    await q('UPDATE invites SET declined_at = now() WHERE id = $1 AND accepted_at IS NULL', [inv.id]);
    return { ok: true };
  });
}
