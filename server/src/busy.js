// A long queue: when the newest shelf photos wait BUSY_ALERT_HOURS or more to be read, the
// admins get one email per busy spell. On /admin#queue an admin can then tell the waiting
// readers by email (each once) that reading takes longer than usual and when theirs should
// be ready. Nobody is emailed about it without that click. The spell ends when the wait
// falls under half the line.
import { config } from './config.js';
import { one, many, q } from './db.js';
import { sendMail } from './mail.js';
import { requireUser } from './auth.js';
import { queueWaits } from './scans.js';

const ALERT_MINS = Number(process.env.BUSY_ALERT_HOURS ?? 3) * 60;
const CHECK_MS = 10 * 60_000;

// The queue now: each waiting scan with its estimate, and the totals.
async function queueNow() {
  const waits = await queueWaits();
  const scans = await many(
    `SELECT s.id, s.user_id, s.source, s.lang, s.busy_told_at, greatest(1, jsonb_array_length(s.media))::int AS photos,
            u.email, COALESCE(u.screen_name, 'Reader #' || u.id) AS who
       FROM scans s JOIN users u ON u.id = s.user_id WHERE s.status IN ('queued', 'processing')`);
  for (const s of scans) s.mins = waits.get(s.id)?.mins ?? 0;
  const shelf = scans.filter((s) => s.source !== 'cover');
  return {
    scans,
    maxMins: Math.max(0, ...shelf.map((s) => s.mins)),
    photos: shelf.reduce((a, s) => a + s.photos, 0),
    readers: new Set(scans.map((s) => s.user_id)).size,
  };
}

const getState = async () => (await one(`SELECT value FROM app_state WHERE key = 'busy_spell'`))?.value ?? null;
const setState = (v) => q(`INSERT INTO app_state(key, value) VALUES ('busy_spell', $1::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);

const hours = (mins) => (mins < 90 ? `${Math.round(mins)} minutes` : `${Math.round(mins / 60)} hours`);

async function check(log) {
  const now = await queueNow();
  const spell = await getState();
  if (spell && now.maxMins < ALERT_MINS / 2) return setState(null);
  if (spell || now.maxMins < ALERT_MINS || !config.adminEmails.length) return;
  await setState({ since: new Date().toISOString(), maxMins: now.maxMins });
  const text = [
    `The scan queue is long: ${now.photos} shelf photos from ${now.readers} readers are waiting.`,
    `Photos sent now would be read in about ${hours(now.maxMins)}.`,
    '',
    `Tell the waiting readers (you see the email first; nothing is sent without your click):`,
    `${config.baseUrl}/admin#queue`,
  ].join('\n');
  for (const to of config.adminEmails) await sendMail({ to, subject: `Seferehov: long queue, about ${hours(now.maxMins)} wait`, text }, log);
}

export function startBusyWatch(log) {
  const run = () => check(log).catch((err) => log.error({ err }, 'busy watch'));
  setTimeout(run, 90_000).unref();
  setInterval(run, CHECK_MS).unref();
}

const LETTER = {
  he: {
    subject: 'התמונות שלך בתור: הקריאה לוקחת יותר זמן מהרגיל',
    body: (when, url) => `הרבה אנשים שלחו היום תמונות של מדפים, ולכן הקריאה לוקחת יותר זמן מהרגיל.\nהתמונות שלך יהיו מוכנות בעוד ${when} בערך, ונשלח לך מייל כשיהיו.\n\nאין צורך לעשות דבר. תמונות של כריכות נקראות עדיין מהר.\n\nתודה על הסבלנות!\n${url}\n\nספרחוב`,
    when: (mins) => (mins < 90 ? `${Math.round(mins)} דקות` : `${Math.round(mins / 60)} שעות`),
  },
  en: {
    subject: 'Your photos are in line: reading takes longer than usual',
    body: (when, url) => `Many people sent shelf photos today, so reading them takes longer than usual.\nYours should be ready in about ${when}. We will email you when they are.\n\nThere is nothing you need to do. Cover photos are still read quickly.\n\nThank you for your patience!\n${url}\n\nSeferehov`,
    when: (mins) => hours(mins),
  },
};

// One email per reader: the latest estimate of their slowest waiting shelf scan.
function readersToTell(scans) {
  const by = new Map();
  for (const s of scans) {
    if (s.source === 'cover' || s.busy_told_at) continue;
    const r = by.get(s.user_id) ?? { user_id: s.user_id, who: s.who, email: s.email, lang: s.lang === 'en' ? 'en' : 'he', mins: 0, photos: 0, ids: [] };
    r.mins = Math.max(r.mins, s.mins);
    r.photos += s.photos;
    r.ids.push(s.id);
    by.set(s.user_id, r);
  }
  return [...by.values()].filter((r) => r.mins >= 60).sort((a, b) => b.mins - a.mins);
}

export default async function busyRoutes(app) {
  const ADMIN = requireUser(3);
  app.get('/api/admin/busy', { preHandler: ADMIN }, async () => {
    const now = await queueNow();
    const tell = readersToTell(now.scans);
    const sample = LETTER.en;
    return {
      spell: await getState(), alertHours: ALERT_MINS / 60, maxMins: now.maxMins, photos: now.photos, readers: now.readers,
      tell: tell.map(({ who, lang, mins, photos }) => ({ who, lang, mins, photos })),
      told: now.scans.filter((s) => s.busy_told_at).length,
      preview: { subject: sample.subject, body: sample.body(sample.when(now.maxMins), `${config.baseUrl}/queue`) },
    };
  });

  app.post('/api/admin/busy/tell', { preHandler: ADMIN }, async (req) => {
    const tell = readersToTell((await queueNow()).scans);
    let sent = 0;
    for (const r of tell) {
      const L = LETTER[r.lang];
      try {
        await sendMail({ to: r.email, subject: L.subject, text: L.body(L.when(r.mins), `${config.baseUrl}/queue`) }, req.log);
        await q(`UPDATE scans SET busy_told_at = now() WHERE id = ANY($1)`, [r.ids]);
        sent++;
      } catch (err) { req.log.error({ err, user: r.user_id }, 'busy email'); }
    }
    return { sent };
  });
}
