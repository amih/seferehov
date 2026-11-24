import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, getPosition } from '../ui.js';
import { t } from '../i18n.js';
import { todoTabs, queueCountStale } from '../todo.js';

// Help check (server/src/help.js): books other readers photographed at public libraries and
// left unchecked. /help lists the libraries; /l/<code>/help shows their books one at a time.

const km = (m) => t('help.km', { km: (m / 1000).toFixed(1) });

export default async function helpView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/help', { replace: true });
  root.innerHTML = `<section class="page"><h1>🙋 ${t('hc.title')}</h1><p class="muted">${t('loading')}</p></section>`;
  // The position only when the phone already allows it (no permission popup on opening); a button asks.
  const granted = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state === 'granted').catch(() => false);
  let pos = granted ? await getPosition({ timeout: 5000 }).catch(() => null) : null;
  async function draw() {
    let r;
    try { r = await api(`/api/help/libraries${pos ? `?lat=${pos.lat.toFixed(3)}&lon=${pos.lon.toFixed(3)}` : ''}`); } catch {
      root.innerHTML = `<section class="page"><p class="note">${t('offline')}</p></section>`;
      return;
    }
    root.innerHTML = `<section class="page">
      ${todoTabs('help')}
      <h1>🙋 ${t('hc.title')}</h1>
      <p>${t('hc.lead', r.points)}</p>
      ${r.libraries.length ? `${pos ? '' : `<p><button class="btn small" id="near">${t('hc.near')}</button></p>`}
      <ul class="help-list">${r.libraries.map((l) => `<li><a href="/l/${esc(l.code)}/help"><b>${esc(l.name || t('free_library'))}</b></a>
        <span class="muted small">${t('hc.row', { n: l.n })}${l.metres != null ? ` · ${km(l.metres)}` : ''}</span></li>`).join('')}</ul>`
    : `<p class="note">${t('hc.none')}</p>`}
    </section>`;
    root.querySelector('#near')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { pos = await getPosition({ timeout: 10000 }); draw(); } catch (err) { toast(err.message); e.target.disabled = false; }
    });
  }
  await draw();
}

export async function helpLibraryView(root, [code]) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=${encodeURIComponent(`/l/${code}/help`)}`, { replace: true });
  root.innerHTML = `<section class="page"><p class="muted">${t('loading')}</p></section>`;
  let data;
  try { data = await api(`/api/help/l/${encodeURIComponent(code)}`); } catch (e) {
    root.innerHTML = `<section class="page"><p class="note">${t(e.status === 404 ? 'loc.notfound_404' : 'offline')}</p><p><a href="/help">${t('hc.more')}</a></p></section>`;
    return;
  }
  const { location: l, points } = data;
  let items = data.items;
  let readyAt = 0; // a tap meant for the book before is ignored for a moment

  function render() {
    const i = items[0];
    const head = `<p class="muted small"><a href="/l/${esc(l.code)}">${esc(l.name || t('free_library'))}</a></p>`;
    if (!i) {
      root.innerHTML = `<section class="page"><h1>🙋 ${t('hc.title')}</h1>${head}
        <p class="note">${t('hc.done')}</p>
        <p class="row"><a class="btn primary" href="/help">${t('hc.more')}</a> <a class="btn" href="/l/${esc(l.code)}">${esc(l.name || t('free_library'))}</a></p></section>`;
      return;
    }
    root.innerHTML = `<section class="page approve help-check">
      <h1>${t('hc.question')}</h1>${head}
      <a href="${esc(i.frame || i.crop)}" target="_blank" class="big-pic crop"><img src="${esc(i.crop)}" alt="${t('scan.photo_of')}"></a>
      <div class="approve-book">
        ${i.cover_url ? `<img class="cover" src="${esc(i.cover_url)}" alt="">` : ''}
        <div><p class="muted small">${t('hc.thinks')}</p>
          <p dir="auto"><b>${esc(i.title)}</b>${i.authors.length ? `<br><span dir="auto">${esc(i.authors.join(', '))}</span>` : ''}${i.year ? ` · ${i.year}` : ''}</p></div>
      </div>
      <div class="decide">
        <button class="btn primary" data-v="1">✓ ${t('hc.right')}</button>
        <button class="btn danger" data-v="0">✕ ${t('hc.wrong')}</button>
        <button class="btn" data-skip>${t('hc.skip')}</button>
      </div>
      <p class="muted small">${t('hc.how')}${items.length > 1 ? ` · ${t('hc.left', { n: items.length - 1 })}` : ''}</p>
    </section>`;
    readyAt = Date.now() + 500;
    root.querySelector('.decide').onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b || Date.now() < readyAt) return;
      if (b.dataset.skip != null) { items = items.slice(1); render(); return; }
      root.querySelectorAll('.decide button').forEach((x) => { x.disabled = true; });
      try {
        const r = await api(`/api/help/${i.id}`, { method: 'POST', json: { right: b.dataset.v === '1' } });
        toast(t(r.decided ? `hc.thanks_${r.decided}` : 'hc.thanks', { points: r.points ?? points.vote }));
      } catch (err) {
        if (err.status !== 404) {
          toast(err.message);
          root.querySelectorAll('.decide button').forEach((x) => { x.disabled = false; });
          return;
        }
        toast(t('hc.gone'));
      }
      queueCountStale();
      items = items.slice(1);
      render();
      window.scrollTo(0, 0);
    };
  }
  render();
}
