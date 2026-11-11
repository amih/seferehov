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
// The last counts are kept on the phone, so the menu shows them the moment it opens. They
// are asked for again only when older than `maxAge` (the app starting, coming back into view
// after a while, the menu or a to-do list opening), and the replies to the reader's own
// decisions update them (setQueueCount). No timer: 1,000 phones polling would be noise.
// Kept with the reader's id, so another reader signing in on the phone never sees them.
const KEY = 'todo-counts';
let last = null;
let lastUser = null;
let lastAt = 0;
let asking = null;
try { ({ user: lastUser, c: last, at: lastAt = 0 } = JSON.parse(localStorage.getItem(KEY)) ?? {}); } catch { /* private mode */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ user: lastUser, c: last, at: lastAt })); } catch { /* private mode */ } };

export const lastTodoCounts = (userId) => (userId != null && userId === lastUser ? last : null);

export function todoCounts(userId = lastUser, { maxAge = 120_000 } = {}) {
  if (last && userId === lastUser && Date.now() - lastAt < maxAge) return Promise.resolve(last);
  asking ??= api('/api/todo').then((c) => { last = c; lastUser = userId; lastAt = Date.now(); save(); return c; })
    .finally(() => { asking = null; });
  return asking;
}

// The reader's own queue (books waiting for approval, scans being read): one copy for every
// screen, fresh for a minute, updated by the replies to their decisions and uploads.
let queue = null, queueAt = 0, queueAsking = null;
export function setQueueCount(c) {
  if (!c || !('open' in c)) return;
  queue = { open: c.open, later: c.later, processing: c.processing, wait: c.wait };
  queueAt = Date.now();
  if (last) { last = { ...last, mine: c.open + c.later, processing: c.processing }; save(); }
}
export function queueCount({ maxAge = 60_000 } = {}) {
  if (queue && Date.now() - queueAt < maxAge) return Promise.resolve(queue);
  queueAsking ??= api('/api/queue/count').then((c) => { setQueueCount(c); return queue; }).finally(() => { queueAsking = null; });
  return queueAsking;
}
export const queueCountStale = () => { queueAt = 0; lastAt = 0; };

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
