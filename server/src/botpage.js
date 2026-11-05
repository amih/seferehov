// /bot: what SeferehovBot reads from publishers' and authors' websites and how to stop it
// (the bot's User-Agent points here; scripts/sites.js).
const PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SeferehovBot — ספרחוב</title><meta name="robots" content="noindex">
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#222}
code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}section+section{margin-top:2.5rem;border-top:1px solid #ddd;padding-top:1.5rem}</style></head>
<body>
<section>
<h1>SeferehovBot</h1>
<p><a href="https://seferehov.com/">ספרחוב</a> הוא מפה חינמית של ספריות רחוב. כשמישהו מצלם מדף ספרים, השמות על שדרות הספרים
נקראים במחשב, ולפעמים בטעות. כדי לתקן את הטעויות אנחנו שומרים רשימה של שמות ספרים ומחברים.</p>
<p>הבוט קורא מאתרים של הוצאות ספרים ושל סופרים <b>רק</b> את שם הספר, שם המחבר, המסת"ב (ISBN) וכתובת הדף.
הוא לא שומר תיאורים, ביקורות או תמונות, ולא מפרסם את הרשימה.</p>
<ul>
<li>הוא מכבד את <code>robots.txt</code> ואת <code>Crawl-delay</code>, ופונה לאתר אחד בכל פעם, לכל היותר בקשה אחת ל־12 שניות.</li>
<li>הוא לא קורא אתר שתנאי השימוש שלו אוסרים רובוטים או העתקה.</li>
<li>כל אתר נקרא מחדש לכל היותר פעם ב־90 יום.</li>
</ul>
<p><b>כדי לעצור אותו:</b> הוסיפו ל־<code>robots.txt</code> את השורות<br><code>User-agent: SeferehovBot</code><br><code>Disallow: /</code><br>
או כתבו ל־<a href="mailto:ami@seferehov.com">ami@seferehov.com</a>, והספרים שנקראו מהאתר יימחקו.</p>
</section>
<section dir="ltr" lang="en">
<h2>SeferehovBot (English)</h2>
<p><a href="https://seferehov.com/">Seferehov</a> is a free map of street libraries. Book spines in shelf photos are read by
a computer, sometimes wrongly; a list of book titles and authors is used to correct them.</p>
<p>From publishers' and authors' websites the bot keeps <b>only</b> the title, author, ISBN and page address. It keeps no
descriptions, reviews or images, and the list is not published.</p>
<ul>
<li>It obeys <code>robots.txt</code> and <code>Crawl-delay</code>, reads one site at a time, at most one request every 12 seconds.</li>
<li>It does not read sites whose terms of use forbid robots or copying.</li>
<li>Each site is read again at most every 90 days.</li>
</ul>
<p><b>To stop it:</b> add <code>User-agent: SeferehovBot</code> / <code>Disallow: /</code> to your <code>robots.txt</code>, or write to
<a href="mailto:ami@seferehov.com">ami@seferehov.com</a> and the books read from your site will be deleted.</p>
</section>
</body></html>`;

export default async function botPage(app) {
  app.get('/bot', async (req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(PAGE));
}
