// /admin/spine-check: the lab (experiment 045) asks the admin what is wrong with cut-outs it is
// unsure about: neighbours in the cut, a bad angle, cut off, a pile... One at a time, a key each.
// The list is a JSON file the lab writes: { made, items: [{ id, guess, note? }] }. The answers are
// kept in spine_check_answers; the lab reads them back from the database.
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';
import { config } from './config.js';
import { readFile } from 'node:fs/promises';

const ADMIN = 3;
export const ANSWERS = ['good', 'trim', 'angle', 'cut_off', 'pile', 'unreadable', 'not_spine'];

async function list() {
  if (!config.spineCheck) return [];
  try {
    const d = JSON.parse(await readFile(config.spineCheck, 'utf8'));
    return (d.items ?? []).map((x) => ({ ...x, id: Number(x.id) })).filter((x) => Number.isInteger(x.id) && x.id > 0);
  } catch { return []; }
}

const TITLE = 'coalesce(gb.title, mb.title, b.title, i.title)';

export default async function spineCheckRoutes(app) {
  app.get('/api/admin/spine-check', { preHandler: requireUser(ADMIN) }, async () => {
    const asked = await list();
    if (!asked.length) return { items: [] };
    const rows = await many(
      `SELECT i.id, i.crop_path, i.frame_path, i.spot, i.decision, ${TITLE} AS title, a.answer
         FROM scan_items i LEFT JOIN books b ON b.id = i.book_id
         LEFT JOIN sightings g ON g.id = i.sighting_id LEFT JOIN books gb ON gb.id = g.book_id
         LEFT JOIN my_books m ON m.id = i.my_book_id LEFT JOIN books mb ON mb.id = m.book_id
         LEFT JOIN spine_check_answers a ON a.item_id = i.id
        WHERE i.id = ANY($1) AND i.crop_path IS NOT NULL`, [asked.map((x) => x.id)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      answers: ANSWERS,
      items: asked.filter((x) => byId.has(x.id)).map((x) => {
        const r = byId.get(x.id);
        return { id: r.id, title: r.title, decision: r.decision, crop: `/uploads/${r.crop_path}`,
          photo: r.frame_path ? `/uploads/${r.frame_path}` : null, poly: r.spot?.poly ?? null,
          guess: ANSWERS.includes(x.guess) ? x.guess : null, note: typeof x.note === 'string' ? x.note : null, answer: r.answer ?? null };
      }),
    };
  });

  app.post('/api/admin/spine-check/:id', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const id = Number(req.params.id) || 0;
    const answer = req.body?.answer;
    const asked = (await list()).find((x) => x.id === id);
    if (!asked) return reply.code(404).send({ error: 'not on the list' });
    if (answer === null) { await q('DELETE FROM spine_check_answers WHERE item_id = $1', [id]); return { ok: true }; }
    if (!ANSWERS.includes(answer)) return reply.code(400).send({ error: 'unknown answer' });
    if (!(await one('SELECT 1 FROM scan_items WHERE id = $1', [id]))) return reply.code(404).send({ error: 'not found' });
    await q(`INSERT INTO spine_check_answers (item_id, answer, guess) VALUES ($1, $2, $3)
             ON CONFLICT (item_id) DO UPDATE SET answer = EXCLUDED.answer, guess = EXCLUDED.guess, at = now()`, [id, answer, asked.guess ?? null]);
    return { ok: true };
  });
}
