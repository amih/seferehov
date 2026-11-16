import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast } from '../ui.js';
import { t } from '../i18n.js';
import { shareLink, rememberInvite } from '../invite.js';

// /invite: my own invite link, and the friends whose books I catalogued: each gets a link
// that invites them and hands their books over in one.
export default async function inviteView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/invite', { replace: true });
  root.innerHTML = `<section class="page"><h1>${t('invite.title')}</h1><p class="muted">${t('loading')}</p></section>`;
  let d;
  try { d = await api('/api/invites'); } catch { root.querySelector('.muted').textContent = t('offline'); return; }
  const friendName = (f) => f.friend_name || t('owner.a_friend');
  root.innerHTML = `<section class="page">
    <h1>${t('invite.title')}</h1>
    <p>${t('invite.lead')}</p>
    <p><input class="share-url" readonly value="${esc(d.link)}" dir="ltr"></p>
    <p class="row"><button class="btn primary" data-share>${t('invite.share')}</button></p>
    ${d.joined ? `<p class="muted small">${t('invite.joined', { n: d.joined })}</p>` : ''}
    ${d.friends.length ? `<h2>${t('invite.friends_title')}</h2><p class="muted small">${t('invite.friends_lead')}</p>
      <p class="row">${d.friends.map((f, i) => `<button class="btn" data-friend="${i}">${esc(t('invite.send_to', { name: friendName(f), n: f.n }))}</button>`).join('')}</p>` : ''}
  </section>`;
  root.querySelector('[data-share]').onclick = () => shareLink({ url: d.link, text: t('invite.text'), title: t('app.name') });
  root.querySelectorAll('[data-friend]').forEach((b) => {
    b.onclick = () => sendBooks(d.friends[Number(b.dataset.friend)]);
  });
}

// A friend's books, with an invite: one link.
export async function sendBooks(f) {
  try {
    const r = await api('/api/invites/handover', { method: 'POST', json: { friend_name: f.friend_name ?? '' } });
    await shareLink({ url: r.link, text: t('invite.handover_text', { n: r.n }), title: t('app.name') });
  } catch (e) { toast(e.message); }
}

// /invite/<code>: what a friend sees when they open the link.
export async function invitedView(root, [code]) {
  rememberInvite(code);
  root.innerHTML = `<section class="page"><p class="muted">${t('loading')}</p></section>`;
  let d;
  try { d = await api(`/api/invites/${encodeURIComponent(code)}`); } catch {
    root.innerHTML = `<section class="page"><h1>${t('invite.notfound')}</h1><p><a href="/">${t('back.map')}</a></p></section>`;
    return;
  }
  const me = await getMe();
  const name = d.from || t('owner.a_friend');
  const books = d.books ?? [];
  const n = books.length;
  const cover = (b) => (b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy">` : '<div class="nocover">📖</div>');
  const stateNote = { accepted: 'invite.state_accepted', declined: 'invite.state_declined', expired: 'invite.state_expired' }[d.state];
  const canTake = d.handover && d.state === 'open' && !d.own && n > 0;
  root.innerHTML = `<section class="page">
    <h1 dir="auto">${esc(d.handover ? t('invite.books_for_you', { name, n }) : t('invite.from', { name }))}</h1>
    ${d.own ? `<p class="note">${t('invite.own')}</p>` : ''}
    <p>${t('shelves.note_html')}</p>
    ${d.handover && stateNote ? `<p class="note">${t(stateNote)}</p>` : ''}
    ${d.handover && n ? `<ul class="books">${books.map((b) => `<li>${cover(b)}<div class="meta"><strong dir="auto">${esc(b.title)}</strong>
      <span class="muted" dir="auto">${esc((b.authors ?? []).join(', '))}</span></div></li>`).join('')}</ul>` : ''}
    ${canTake ? `<p class="muted small">${t('invite.private_note')}</p>
      ${me ? `<p class="row"><button class="btn primary" data-accept>${t('invite.accept', { n })}</button><button class="btn" data-decline>${t('invite.decline')}</button></p>`
        : `<p><a class="btn primary" href="/login?next=${encodeURIComponent(location.pathname)}">${t('invite.signin')}</a></p>`}` : ''}
    ${!d.handover && !me ? `<p><a class="btn primary" href="/login?next=/">${t('invite.join')}</a></p>` : ''}
    <p><a href="/">${t('back.map')}</a> · <a href="/comic">${t('menu.comic')}</a></p>
  </section>`;
  root.querySelector('[data-accept]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' });
      toast(t('invite.accepted', { n: r.moved }), 6000);
      navigate('/books');
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  root.querySelector('[data-decline]')?.addEventListener('click', async () => {
    try { await api(`/api/invites/${encodeURIComponent(code)}/decline`, { method: 'POST' }); toast(t('invite.declined')); invitedView(root, [code]); } catch (err) { toast(err.message); }
  });
}
