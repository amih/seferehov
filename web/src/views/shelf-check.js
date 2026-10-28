import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, getPosition, timeAgo } from '../ui.js';
import { t } from '../i18n.js';
import { bookShots, coversTarget } from '../shots.js';

// After shelf photos at a library (several uploads within a few hours are one visit):
// the books the photos confirmed as still there, spines found in no catalogue (take the
// book out and photograph its covers), and, once there are enough photos, the books
// listed here that none of the photos showed: still here, or gone?
export default async function shelfCheckView(root, [code]) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=/l/${code}/check`, { replace: true });
  let timer = null, stopped = false, pos = null;
  getPosition().then((p) => { pos = p; }).catch(() => {});

  root.innerHTML = `<section class="page shelf-check">
    <p><a href="/l/${code}">${t('back.library')}</a></p>
    <h1>🔎 ${t('check.title')}</h1>
    <div id="body"><p class="muted">${t('loading')}</p></div>
    <div class="shots" id="shots" hidden></div>
  </section>`;
  const body = root.querySelector('#body');
  const shots = bookShots({ on: root, panel: root.querySelector('#shots') });

  const cover = (b) => (b.cover_url ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy">` : '<div class="nocover">📖</div>');

  async function show() {
    clearTimeout(timer);
    let d;
    try { d = await api(`/api/locations/${code}/shelf-check`); } catch (e) { body.innerHTML = `<p class="note">${esc(e.message)}</p>`; return; }
    if (!d.scans) {
      body.innerHTML = `<p>${t('check.none')}</p><p><a class="btn primary" href="/l/${code}/add">📷 ${t('add3.photo')}</a></p>`;
      return;
    }
    body.innerHTML = `
      ${d.processing ? `<p class="progress-line"><span class="spinner"></span> ${t('check.reading', { n: d.processing })}</p>` : ''}
      <h2>✓ ${t('check.confirmed')} <span class="count">${d.confirmed.length}</span></h2>
      ${d.confirmed.length ? `<ul class="check-confirmed">${d.confirmed.map((b) => `<li><a href="/l/${code}/b/${b.id}">${cover(b)}<span dir="auto">${esc(b.title)}</span></a></li>`).join('')}</ul>`
        : `<p class="muted small">${t(d.processing ? 'check.wait' : 'check.confirmed_none')}</p>`}
      <h2>📕 ${t('check.fresh')} <span class="count">${d.fresh.length}</span></h2>
      ${d.fresh.length ? `<p>${t('check.fresh_lead')}</p>
        <ul class="check-fresh">${d.fresh.map((i) => `<li data-item="${i.id}">
          ${i.crop || i.frame ? `<a href="${esc(i.frame || i.crop)}" target="_blank" class="spine"><img src="${esc(i.crop || i.frame)}" alt=""></a>` : ''}
          <p dir="auto"><b>${esc(i.title)}</b>${i.author ? ` · ${esc(i.author)}` : ''}</p>
          <p class="row"><button class="btn primary small" data-covers="${i.id}">📷 ${t('check.take_out')}</button>
            <a class="btn small" href="/queue">${t('check.as_read')}</a></p></li>`).join('')}</ul>`
        : `<p class="muted small">${t(d.processing ? 'check.wait' : 'check.fresh_none')}</p>`}
      <h2>❓ ${t('check.missing')}${d.enough && !d.processing ? ` <span class="count">${d.missing.length}</span>` : ''}</h2>
      ${!d.enough ? `<p>${t('check.more_photos', { n: d.photos, need: d.enoughPhotos })}</p><p><a class="btn" href="/l/${code}/add">📷 ${t('check.add_photos')}</a></p>`
        : d.processing ? `<p class="muted small">${t('check.wait')}</p>`
        : d.missing.length ? `<p>${t('check.missing_lead')}</p><ul class="check-missing">${d.missing.map((b) => `<li data-id="${b.id}">${cover(b)}
            <div><p dir="auto"><b>${esc(b.title)}</b>${b.authors?.length ? ` · ${esc(b.authors.join(', '))}` : ''}</p>
            <p class="muted small">${t('check.last_seen', { when: timeAgo(b.last_seen) })}</p>
            <p class="row"><button class="btn small" data-kind="seen">${t('loc.still')}</button><button class="btn small danger" data-kind="gone">✕ ${t('loc.gone')}</button></p></div></li>`).join('')}</ul>`
        : `<p class="note">${t('check.missing_none')}</p>`}`;
    const c = await api('/api/queue/count').catch(() => null);
    if (c?.open + c?.later) body.insertAdjacentHTML('beforeend', `<p><a class="btn" href="/queue">📥 ${t('queue.link', c)}</a></p>`);
    if (d.processing && !stopped) timer = setTimeout(show, 8000);
  }

  body.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-covers]');
    if (c) {
      const li = c.closest('li');
      shots.start({ single: true, intro: t('check.covers_intro', { title: esc(li.querySelector('b').textContent) }), target: coversTarget({ code, kind: 'seen', pos, replaces: c.dataset.covers }),
        sent: () => { li.remove(); toast(t('check.covers_sent')); return null; } });
      return;
    }
    const k = e.target.closest('[data-kind]');
    if (!k) return;
    const li = k.closest('li');
    const form = new FormData();
    form.append('book_id', li.dataset.id);
    form.append('kind', k.dataset.kind);
    if (pos) { form.append('lat', pos.lat); form.append('lon', pos.lon); }
    li.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const r = await api(`/api/locations/${code}/sightings`, { method: 'POST', form });
      toast(t(r.sighting.status === 'approved' ? 'loc.thanks_updated' : 'loc.thanks_review'));
      li.remove();
    } catch (err) { toast(err.message); li.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
  });

  show();
  return () => { stopped = true; clearTimeout(timer); shots.stop(); };
}
