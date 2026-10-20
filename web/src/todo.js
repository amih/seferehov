import { api } from './api.js';
import { esc } from './ui.js';
import { t } from './i18n.js';

// Everything that waits for the reader, in one place: their own books to approve, and for
// reviewers and admins the reports to review, duplicate books and libraries, and cover texts. One menu
// item; each list's page starts with tabs to the others (only those the reader may see).
const TABS = [
  ['mine', '/queue', '📥'],
  ['review', '/review', '✅'],
  ['duplicates', '/duplicates', '🧩'],
  ['libraries', '/duplicate-libraries', '📍'],
  ['texts', '/admin#texts', '🔤'],
];
let last = null;

export const lastTodoCounts = () => last;

export async function todoCounts() {
  last = await api('/api/todo');
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
  todoCounts().then(() => document.querySelectorAll(`.todo-tabs[data-active="${active}"]`).forEach((n) => { n.innerHTML = html(active); }), () => {});
  return `<nav class="todo-tabs" data-active="${active}">${html(active)}</nav>`;
}
