// Notes for one reader on one screen (table user_notes): the admin writes them (POST /api/admin/notes),
// the reader sees each on that screen until they tap "done"; "later" hides it for a day.
// First use, 26 Nov 2026: the admin's own reminder of lab test 074 on the camera screen.
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';

const ADMIN = 3;
const SCREENS = new Set(['camera', 'map']);

export default async function noteRoutes(app) {
  app.get('/api/notes', { preHandler: requireUser() }, async (req) => {
    const screen = SCREENS.has(req.query.screen) ? req.query.screen : 'camera';
    return {
      notes: await many(
        `SELECT id, text_he, text_en FROM user_notes
          WHERE user_id = $1 AND screen = $2 AND done_at IS NULL AND (later_until IS NULL OR later_until < now())
          ORDER BY id`, [req.user.id, screen]),
    };
  });

  app.post('/api/notes/:id', { preHandler: requireUser() }, async (req, reply) => {
    const action = req.body?.action;
    if (!['done', 'later'].includes(action)) return reply.code(400).send({ error: 'bad_action' });
    const sql = action === 'done'
      ? `UPDATE user_notes SET done_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`
      : `UPDATE user_notes SET later_until = now() + interval '1 day' WHERE id = $1 AND user_id = $2 RETURNING id`;
    const row = await one(sql, [Number(req.params.id), req.user.id]);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/api/admin/notes', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const { user_id: userId, screen = 'camera', text_he: he, text_en: en } = req.body ?? {};
    if (!Number.isInteger(userId) || !SCREENS.has(screen) || !he?.trim() || !en?.trim()) return reply.code(400).send({ error: 'bad_note' });
    const row = await one(`INSERT INTO user_notes (user_id, screen, text_he, text_en) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, screen, he.trim(), en.trim()]);
    return { id: row.id };
  });
}

// For tests: drop every note of a user.
export const clearNotes = (userId) => q(`DELETE FROM user_notes WHERE user_id = $1`, [userId]);
