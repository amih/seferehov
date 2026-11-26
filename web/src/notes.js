// A note the admin left for this reader on this screen (server/src/notes.js): a card with
// "done" (gone for good) and "later" (back tomorrow). Nothing shows when signed out or offline.
import { api } from './api.js';
import { esc } from './ui.js';
import { lang, t } from './i18n.js';

export async function showNotes(el, screen) {
  if (!el) return;
  let notes = [];
  try { ({ notes } = await api(`/api/notes?screen=${screen}`, { timeout: 8000 })); } catch { return; }
  if (!notes?.length || !el.isConnected) return;
  el.innerHTML = notes.map((n) => `<div class="user-note" data-note="${n.id}">
      <p>${esc(lang() === 'he' ? n.text_he : n.text_en).replace(/\n/g, '<br>')}</p>
      <div class="user-note-btns"><button class="btn small" data-act="later">${t('note.later')}</button>
      <button class="btn small primary" data-act="done">${t('note.done')}</button></div></div>`).join('');
  el.hidden = false;
  el.onclick = async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const card = b.closest('[data-note]');
    card.remove();
    if (!el.children.length) el.hidden = true;
    api(`/api/notes/${card.dataset.note}`, { method: 'POST', json: { action: b.dataset.act } }).catch(() => {});
  };
}
