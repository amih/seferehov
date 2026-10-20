import { getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc } from '../ui.js';
import { t } from '../i18n.js';
import { todoTabs } from '../todo.js';
import { fixVoteList } from '../fixes.js';

// Readers' corrections to books, waiting for votes.
export default async function fixesView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/fixes', { replace: true });
  root.innerHTML = `<section class="page"><h1>${t('fix.queue_title')}</h1><p class="muted">${t('loading')}</p></section>`;
  try { return await fixVoteList(root, todoTabs('fixes')); } catch (e) {
    root.innerHTML = `<section class="page"><p class="note">${esc(e.message)}</p></section>`;
  }
}
