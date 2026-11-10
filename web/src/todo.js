import { api } from './api.js';
import { esc } from './ui.js';
import { t } from './i18n.js';

// Everything that waits for the reader, in one place: their own books to approve, and for
// trusted readers corrections to vote on, for reviewers and admins the reports to review, duplicate books and libraries, and cover texts. One menu
// item; each list's page starts with tabs to the others (only those the reader may see).
const TABS = [
  ['mine', '/queue', '📥'],
  ['review', '/review', '✅'],
  ['fixes', '/fixes', '✏️'],
  ['duplicates', '/duplicates', '🧩'],
  ['libraries', '/duplicate-libraries', '📍'],
  ['texts', '/admin#texts', '🔤'],
];
// The last counts are kept on the phone, so the menu shows them the moment it opens; they
// are brought up to date in the background (main.js: at start, every minute while the app
// is in view, and when it comes back into view). Kept with the reader's id, so another
// reader signing in on the phone never sees them.
const KEY = 'todo-counts';
let last = null;
let lastUser = null;
try { ({ user: lastUser, c: last } = JSON.parse(localStorage.getItem(KEY)) ?? {}); } catch { /* private mode */ }

export const lastTodoCounts = (userId) => (userId != null && userId === lastUser ? last : null);

export async function todoCounts(userId = lastUser) {
  last = await api('/api/todo');
  lastUser = userId;
  try { localStorage.setItem(KEY, JSON.stringify({ user: userId, c: last })); } catch { /* private mode */ }
  return last;
}

const html = (active) => {
  const tabs = TABS.filter(([k]) => last && k in last);
  if (tabs.length < 2) return '';
  return tabs.map(([k, href, icon]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${icon} ${esc(t(`todo.${k}`))}${
    last[k] ? ` <b class="count">${last[k]}</b>` : ''}</a>`).join('');
};

// The tabs, from the last counts at once, then brought up to date.
export function todoTabs(active) {
  todoCounts(lastUser).then(() => document.querySelectorAll(`.todo-tabs[data-active="${active}"]`).forEach((n) => { n.innerHTML = html(active); }), () => {});
  return `<nav class="todo-tabs" data-active="${active}">${html(active)}</nav>`;
}
