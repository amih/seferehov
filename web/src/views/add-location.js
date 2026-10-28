import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, getMe } from '../api.js';
import { enqueue } from '../queue.js';
import { navigate } from '../nav.js';
import { getPosition, shrinkImage, toast, privacyDialog } from '../ui.js';
import { t } from '../i18n.js';

export default async function addLocationView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/add', { replace: true });

  root.innerHTML = `
  <section class="page">
    <h1>${t('addloc.title')}</h1>
    <ol class="wiz-steps"><li data-s="0">${t('wiz.photo')}</li><li data-s="1">${t('wiz.name')}</li><li data-s="2">${t('wiz.place')}</li></ol>
    <form id="f" class="form">
      <div class="wiz" data-step="0">
        <p class="muted">${t('wiz.photo_lead')}</p>
        <label class="photo-pick">
          <input type="file" name="photo" accept="image/*" capture="environment" hidden>
          <span id="photo-preview">${t('addloc.photo')}</span>
        </label>
        <p class="row"><button class="btn primary big" type="button" data-next disabled>${t('wiz.next')}</button></p>
      </div>
      <div class="wiz" data-step="1" hidden>
        <label>${t('addloc.name')} <span class="muted">${t('optional')}</span>
          <input name="name" maxlength="120" placeholder="${t('addloc.name_ph')}"></label>
        <label>${t('addloc.hint')} <span class="muted">${t('optional')}</span>
          <textarea name="description" maxlength="1000" rows="3" placeholder="${t('addloc.hint_ph')}"></textarea></label>
        <p class="field-note">${t('privacy.hint')}</p>
        <p class="row"><button class="btn primary" type="button" data-next>${t('wiz.next')}</button>
          <button class="btn" type="button" data-skip>${t('wiz.skip_name')}</button>
          <button class="link" type="button" data-prev>${t('wiz.back')}</button></p>
      </div>
      <div class="wiz" data-step="2" hidden>
        <p class="muted">${t('wiz.place_lead')}</p>
        <div id="mini-map" class="mini-map"></div>
        <p id="gps" class="muted small">${t('addloc.gps_wait')}</p>
        <fieldset class="yesno"><legend>${t('addloc.restricted_q')}</legend>
          <label class="check"><input type="radio" name="restricted" value="0" checked> ${t('addloc.restricted_no')}</label>
          <label class="check"><input type="radio" name="restricted" value="1"> ${t('addloc.restricted_yes')}</label>
        </fieldset>
        <p class="row"><button class="btn primary big" type="submit">${t('addloc.submit')}</button>
          <button class="link" type="button" data-prev>${t('wiz.back')}</button></p>
      </div>
    </form>
  </section>`;

  const form = root.querySelector('#f');
  const gpsText = root.querySelector('#gps');
  let pos = null;
  let photo = null;

  const map = L.map(root.querySelector('#mini-map'), { zoomControl: false, attributionControl: false }).setView([32.08, 34.78], 16);
  let removed = false;
  import('../basemap.js').then((m) => m.basemap()).then((layer) => { if (!removed) layer.addTo(map); });
  const marker = L.marker([32.08, 34.78], { draggable: true });
  marker.on('dragend', () => {
    const p = marker.getLatLng();
    pos = { ...pos, lat: p.lat, lon: p.lng };
    gpsText.textContent = t('addloc.moved');
  });

  getPosition().then((p) => {
    pos = p;
    marker.setLatLng([p.lat, p.lon]).addTo(map);
    map.setView([p.lat, p.lon], 18);
    gpsText.textContent = t('addloc.found', { acc: Math.round(p.accuracy) });
  }).catch((e) => { gpsText.textContent = t('addloc.tap', { msg: e.message }); });
  map.on('click', (e) => {
    pos = { lat: e.latlng.lat, lon: e.latlng.lng, accuracy: null };
    marker.setLatLng(e.latlng).addTo(map);
    gpsText.textContent = t('addloc.placed');
  });

  // Steps: the photo (needed), name and hint (skip = no name), the place (GPS unless moved).
  let step = 0;
  const show = (n) => {
    step = n;
    root.querySelectorAll('.wiz').forEach((w) => { w.hidden = Number(w.dataset.step) !== n; });
    root.querySelectorAll('.wiz-steps li').forEach((li) => { li.className = Number(li.dataset.s) < n ? 'done' : Number(li.dataset.s) === n ? 'on' : ''; });
    if (n === 2) setTimeout(() => map.invalidateSize());
    window.scrollTo(0, 0);
  };
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) show(step + 1);
    else if (e.target.closest('[data-skip]')) { form.name.value = ''; form.description.value = ''; show(step + 1); }
    else if (e.target.closest('[data-prev]')) show(step - 1);
  });
  show(0);

  form.photo.onchange = async () => {
    const file = form.photo.files[0];
    if (!file) return;
    photo = await shrinkImage(file);
    root.querySelector('#photo-preview').innerHTML = `<img src="${URL.createObjectURL(photo)}" alt="">`;
    root.querySelector('[data-step="0"] [data-next]').disabled = false;
  };

  let sending = false;
  async function submit(force = false, confirmPrivate = false) {
    if (sending) return; // a double tap would add the library twice
    if (!photo) { show(0); return toast(t('wiz.need_photo')); }
    if (!pos) return toast(t('addloc.need_pos'));
    const fields = {
      lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy ?? '',
      name: form.name.value, description: form.description.value,
      restricted: form.restricted.value === '1' ? '1' : '0', force: force ? '1' : '0', confirm_private: confirmPrivate ? '1' : '0',
    };
    if (!navigator.onLine) {
      await enqueue('/api/locations', fields, { photo }, 'library');
      toast(t('addloc.offline_saved'));
      return navigate('/');
    }
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
    if (photo) fd.append('photo', photo, 'photo.jpg');
    const button = form.querySelector('[type="submit"]');
    sending = true; button.disabled = true;
    try {
      const { location: l } = await api('/api/locations', { method: 'POST', form: fd });
      toast(t(l.status === 'approved' ? 'addloc.added_live' : 'addloc.added_review'));
      navigate(`/l/${l.code}`, { replace: true });
    } catch (e) {
      sending = false; button.disabled = false;
      if (e.body?.error === 'private_info') {
        if (await privacyDialog(e.body.snippets)) submit(force, true);
        else { show(1); form.description.focus(); }
      } else if (e.body?.error === 'nearby_exists') {
        const d = e.body.location;
        if (confirm(t('addloc.dup', { name: d.name || d.code }))) navigate(`/l/${d.code}`);
        else submit(true, confirmPrivate);
      } else if (e.status === undefined || e instanceof TypeError || e.status >= 500 || e.status === 429) {
        await enqueue('/api/locations', fields, { photo }, 'library');
        toast(t('addloc.conn'));
      } else toast(e.message);
    }
  }
  form.onsubmit = (e) => { e.preventDefault(); submit(); };
  return () => { removed = true; map.remove(); };
}
