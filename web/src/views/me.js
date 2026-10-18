import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, avatarHtml, contactHtml } from '../ui.js';
import { t } from '../i18n.js';

const NAME_ERRORS = ['invalid_screen_name', 'screen_name_taken'];

export default async function meView(root, _, query) {
  const me = await getMe(true);
  if (!me) return navigate('/login', { replace: true });
  const welcome = query.get('welcome');
  const goNext = () => {
    const next = sessionStorage.getItem('seferehov:next');
    sessionStorage.removeItem('seferehov:next');
    if (next) { navigate(next, { replace: true }); return true; }
    return false;
  };
  if (welcome && me.screen_name && goNext()) return;

  const needsName = !me.screen_name;
  root.innerHTML = `
  <section class="page">
    ${needsName ? `<h1>${t('me.welcome')}</h1><p>${t('shelves.note_html')}</p><p>${t('me.choose')}</p>`
      : `<div class="profile-head">${avatarHtml(me, 72)}<div><h1>${esc(me.screen_name)}</h1><p class="muted">${t('me.levels')[me.trust_level]}</p>
        <p class="small"><a href="/r/${me.id}">${t('reader.my_page')}</a></p></div></div>`}
    <form class="form" id="name">
      <label>${t('me.screen_name')}
        <input name="screen_name" maxlength="30" minlength="3" required value="${esc(me.screen_name ?? '')}" placeholder="${t('me.name_ph')}" autocomplete="nickname"></label>
      <p class="field-error" id="name-err" hidden></p>
      <button class="btn${needsName ? ' primary big' : ''}">${t(needsName ? 'me.continue' : 'me.save')}</button>
    </form>
    ${needsName ? '' : `
    <h2>${t('me.picture')}</h2>
    <div class="row avatar-row">
      ${avatarHtml(me, 56)}
      <label class="btn">📷 ${t(me.avatar ? 'me.replace' : 'me.addpic')}<input type="file" accept="image/*" id="avatar" hidden></label>
      ${me.avatar_source === 'upload' ? `<button class="btn" id="avatar-reset">${t(me.can_use_google_picture ? 'me.use_google' : 'me.remove')}</button>` : ''}
    </div>
    ${me.avatar_source === 'google' ? `<p class="muted small">${t('me.google_note')}</p>` : ''}
    <div class="stats">
      <div><strong>${me.karma}</strong><span>${t('stat.points')}</span></div>
      <div><strong>${me.locations}</strong><span>${t('stat.libraries')}</span></div>
      <div><strong>${me.sightings}</strong><span>${t('stat.reports')}</span></div>
    </div>
    ${me.trust_level === 0 ? `<p class="muted small">${t('me.first')}</p>` : ''}
    <h2>🔔 ${t('watch.mine')}</h2>
    <ul class="watches" id="watches"><li class="muted">${t('loading')}</li></ul>
    <p class="row">
      ${me.trust_level >= 2 ? `<a class="btn" href="/review">${t('me.review')}</a>` : ''}
      <a class="btn" href="/about">${esc(t('me.about'))}</a>
      <button class="btn" id="logout">${t('me.logout')}</button>
    </p>
    <p class="muted small">${t('me.signed_as_html', { email: esc(me.email), google: me.has_google })}</p>
    <h2>${t('contact.title')}</h2>
    ${contactHtml()}`}
  </section>`;

  const rerender = () => meView(root, _, new URLSearchParams());
  root.querySelector('#name').onsubmit = async (e) => {
    e.preventDefault();
    const err = root.querySelector('#name-err');
    try {
      await api('/api/me', { method: 'POST', json: { screen_name: e.target.screen_name.value } });
      await getMe(true);
      document.dispatchEvent(new Event('seferehov:me'));
      if (needsName && goNext()) return;
      toast(t('saved'));
      rerender();
    } catch (ex) {
      err.textContent = t(NAME_ERRORS.includes(ex.body?.error) ? `me.err.${ex.body.error}` : 'me.save_fail');
      err.hidden = false;
    }
  };
  root.querySelector('#avatar')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      await api('/api/me/avatar', { method: 'POST', form: fd });
      document.dispatchEvent(new Event('seferehov:me'));
      toast(t('me.pic_updated'));
      rerender();
    } catch { toast(t('me.pic_bad')); }
  });
  root.querySelector('#avatar-reset')?.addEventListener('click', async () => {
    await api('/api/me/avatar', { method: 'DELETE' });
    document.dispatchEvent(new Event('seferehov:me'));
    rerender();
  });
  const watchList = root.querySelector('#watches');
  if (watchList) {
    const showWatches = async () => {
      let watches = [];
      try { ({ watches } = await api('/api/watches')); } catch { /* offline */ }
      watchList.innerHTML = watches.length ? watches.map((w) => `<li><span><strong>${esc(w.title)}</strong> · ${esc(
        w.scope === 'here' ? t('watch.scope_here', { lib: w.location_name || t('free_library') })
          : w.scope === 'near' ? t('watch.scope_near', { km: w.km }) : t('watch.scope_anywhere'))}</span>
        <button class="link" data-unwatch="${w.id}">${t('watch.remove')}</button></li>`).join('')
        : `<li class="muted">${t('watch.none')}</li>`;
    };
    watchList.onclick = async (e) => {
      const b = e.target.closest('[data-unwatch]');
      if (!b) return;
      await api(`/api/watches/${b.dataset.unwatch}`, { method: 'DELETE' }).catch(() => {});
      showWatches();
    };
    showWatches().then(() => { if (location.hash === '#watches') watchList.scrollIntoView({ block: 'center' }); });
  }

  root.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    await getMe(true);
    document.dispatchEvent(new Event('seferehov:me'));
    navigate('/');
  });
}
