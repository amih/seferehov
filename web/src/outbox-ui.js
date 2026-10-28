import { onItem } from './queue.js';
import { esc } from './ui.js';
import { t } from './i18n.js';

// A line that follows one upload from the outbox (queue.js): saved on the phone, being
// sent, sent (sent(data) may return the line to show then, e.g. the book's title),
// waiting (no signal / sign in / server busy) or refused.
export function trackLine(li, id, { label, sent = null, before = '' }) {
  const line = (html) => { li.innerHTML = `${before}<span>${html}</span>`; };
  line(`💾 ${esc(label)} — ${t('out.stored')}`);
  return onItem(id, (state, info) => {
    if (state === 'sending') line(`<span class="spinner"></span> ${esc(label)} — ${t('out.sending')}`);
    else if (state === 'sent') line(sent?.(info) ?? `✓ ${esc(label)} — ${t('out.sent')}`);
    else if (state === 'waiting') line(`💾 ${esc(label)} — ${t(`out.waiting_${info}`)}`);
    else if (state === 'failed') line(`⚠️ ${esc(label)} — ${esc(info?.reason ?? '')}${info?.dropped ? '' : ` · ${t('out.kept')}`}`);
  });
}
