import { api, getMe } from '../api.js';
import { toast } from '../ui.js';
import { t, lang, setLang } from '../i18n.js';
import { muted, setMuted } from '../sound.js';
import { canOfferInstall, install } from '../install.js';
import { checkForUpdate, hardReset, isUpdateWaiting, maybeApply } from '../update.js';
import { pushSupported, isIos, installed, currentSub, enablePush, disablePush } from '../push.js';

// Everything the reader can set, signed in or not: sounds and language are kept on this
// device; notifications belong to the account.
export default async function settingsView(root) {
  const me = await getMe();
  root.innerHTML = `
  <section class="page settings">
    <h1>⚙️ ${t('settings.title')}</h1>
    <h2>🔊 ${t('settings.sound')}</h2>
    <label class="check"><input type="checkbox" id="sound" ${muted() ? '' : 'checked'}> ${t('settings.sound_label')}</label>
    <p class="muted small">${t('settings.this_device')}</p>
    <h2>🌐 ${t('lang.label')}</h2>
    <div class="seg" id="langs"><button data-l="he" lang="he">עברית</button><button data-l="en" lang="en">English</button></div>
    <h2 id="notify">🔔 ${t('notify.title')}</h2>
    ${me ? `<p>${t('notify.lead')}</p>
    <div class="notify-opts">
      <label class="check"><input type="checkbox" id="n-push"> 📱 ${t('notify.phone')}</label> <span class="muted small" id="n-push-state"></span>
      <label class="check"><input type="checkbox" id="n-email" ${me.notify_email ? 'checked' : ''}> ✉️ ${t('notify.email')}</label>
    </div>
    <p class="muted small" id="n-note" hidden></p>
    <p class="small"><a href="/me#watches">${t('menu.watches')}</a></p>`
    : `<p><a class="btn" href="/login?next=/settings%23notify">${t('menu.signin')}</a></p>`}
    <h2>📲 ${t('about.install')}</h2>
    ${canOfferInstall() ? `<p><button class="btn" id="install">${t('menu.install')}</button></p>` : ''}
    <p class="small">${t('about.install_html')}</p>
    <h2>${t('about.version')}</h2>
    <p>${t('about.running_html', { v: __APP_VERSION__ })}</p>
    <p class="row"><button class="btn" id="upd">${t('about.check')}</button><button class="btn" id="reset">${t('about.repair')}</button></p>
  </section>`;

  root.querySelector('#sound').onchange = (e) => { setMuted(!e.target.checked); toast(t(e.target.checked ? 'sound.on' : 'sound.muted')); };
  root.querySelectorAll('#langs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.l === lang());
    b.onclick = () => setLang(b.dataset.l);
  });
  root.querySelector('#install')?.addEventListener('click', install);
  root.querySelector('#upd').onclick = async () => {
    checkForUpdate();
    toast(t('about.checking'));
    setTimeout(() => {
      if (isUpdateWaiting()) { toast(t('about.installing')); maybeApply(); }
      else toast(t('about.latest'));
    }, 3000);
  };
  root.querySelector('#reset').onclick = () => {
    if (confirm(t('about.reset_confirm'))) hardReset();
  };

  // Phone: on only when this device has an address and the reader wants it.
  const nPush = root.querySelector('#n-push');
  if (nPush) {
    const note = (key) => { const n = root.querySelector('#n-note'); n.hidden = !key; if (key) n.textContent = t(key); };
    const showPush = async () => {
      const sub = await currentSub().catch(() => null);
      nPush.checked = !!sub && me.notify_push;
      root.querySelector('#n-push-state').textContent = nPush.checked ? t('notify.on_this') : '';
    };
    if (!pushSupported()) { nPush.disabled = true; note(isIos() && !installed() ? 'notify.ios' : 'notify.unsupported'); }
    else if (Notification.permission === 'denied') { nPush.disabled = true; note('notify.denied'); }
    else showPush();
    nPush.onchange = async () => {
      nPush.disabled = true;
      try {
        if (nPush.checked) {
          const ok = await enablePush();
          if (!ok) note(Notification.permission === 'denied' ? 'notify.denied' : 'notify.unsupported');
          await api('/api/me/notify', { method: 'POST', json: { push: true } });
          me.notify_push = true;
        } else {
          await disablePush();
        }
      } catch (e) { toast(e.message); }
      nPush.disabled = false;
      showPush();
    };
    root.querySelector('#n-email').onchange = async (e) => {
      await api('/api/me/notify', { method: 'POST', json: { email: e.target.checked } }).then(() => toast(t('saved')), (err) => toast(err.message));
    };
  }
  if (location.hash === '#notify') root.querySelector('#notify').scrollIntoView({ block: 'start' });
}
