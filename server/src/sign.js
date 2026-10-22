import QRCode from 'qrcode';
import { config } from './config.js';
import { escapeHtml } from './util.js';
import { locationByCode } from './locations.js';

const TEXT = {
  he: {
    dir: 'rtl', name: 'ספרחוב', tag: 'מפת ספריות הרחוב',
    lead: '<strong>המדף הזה פתוח לכולם, כמו תמיד.</strong> ספרחוב היא אפליקציה חינמית לאוהבי ספרים: היא מראה איפה יש מדפי ספרים ציבוריים ואילו ספרים נמצאים בהם. האפליקציה לא מנהלת את המדף הזה ולא מוסיפה לו כללים.',
    steps: ['סרקו את הקוד כדי לראות אילו ספרים יש כאן עכשיו.', 'לקחתם ספר או השארתם אחד? אפשר לעדכן באפליקציה — לא חובה.', 'מכירים עוד מדף ספרים ציבורי? הוסיפו אותו למפה.'],
    print: 'הדפסה',
  },
  en: {
    dir: 'ltr', name: 'Seferehov', tag: 'A map of free street libraries',
    lead: '<strong>This shelf is open to everyone, as always.</strong> Seferehov is a free app for book lovers. It shows where public book shelves are and which books are on them. This app does not run this shelf and adds no rules to it.',
    steps: ['Scan the code to see which books are here now.', 'Took a book or left one? You can say so in the app — not required.', 'Know another public book shelf? Add it to the map.'],
    print: 'Print',
  },
};

// Printable A5 sign for a library: what Seferehov is + a QR code to this location.
export default async function signRoutes(app) {
  app.get('/api/locations/:code/sign', async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!loc || loc.status !== 'approved') return reply.code(404).send('Not found');
    const url = `${config.baseUrl}/l/${loc.code}`;
    const lang = req.query.lang === 'en' ? 'en' : 'he';
    const T = TEXT[lang];
    const qr = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="${lang}" dir="${T.dir}"><head><meta charset="utf-8"><title>${T.name} ${loc.code}</title>
<style>
  @page { size: A5 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; color: #2b2118; }
  .sheet { width: 124mm; min-height: 180mm; margin: 0 auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4mm; }
  .logo { width: 30mm; }
  h1 { font-size: 22pt; margin: 0; letter-spacing: .04em; }
  .tag { font-size: 11pt; margin: 0; color: #7a5232; }
  .qr { width: 62mm; height: 62mm; }
  .qr svg { width: 100%; height: 100%; }
  p { font-size: 11pt; line-height: 1.4; margin: 0; }
  .code { font: 600 14pt ui-monospace, monospace; letter-spacing: .15em; }
  ol { text-align: start; font-size: 11pt; line-height: 1.5; margin: 0; padding-inline-start: 6mm; }
  .print { margin: 8mm auto; display: block; font-size: 14pt; padding: 3mm 8mm; }
  @media print { .print { display: none; } }
</style></head><body>
<div class="sheet">
  <img class="logo" src="/icons/icon-v2-192.png" alt="">
  <h1>${T.name}</h1>
  <p class="tag">${T.tag}</p>
  <p>${T.lead}</p>
  <div class="qr">${qr}</div>
  <p class="code" dir="ltr">${escapeHtml(new URL(url).host)}/l/${escapeHtml(loc.code)}</p>
  <ol>${T.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
  ${loc.name ? `<p><em>${escapeHtml(loc.name)}</em></p>` : ''}
</div>
<button class="print" onclick="print()">${T.print}</button>
</body></html>`);
  });
}
