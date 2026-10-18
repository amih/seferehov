// Reader levels by total karma (points: server/src/config.js POINTS). Shared by the app
// and the server-rendered reader pages. Names are in i18n.js as level.<key>.
export const LEVELS = [
  { min: 0, key: 'page_turner', badge: '📖' },
  { min: 500, key: 'book_worm', badge: '🐛' },
  { min: 1500, key: 'shelf_scout', badge: '🧭' },
  { min: 5000, key: 'guardian', badge: '🛡️' },
];

// { level, next (null at the top), toNext, share (0–1 of the way to the next) }
export function levelOf(karma = 0) {
  const i = LEVELS.findLastIndex((l) => karma >= l.min);
  const level = LEVELS[i], next = LEVELS[i + 1] ?? null;
  return { level, next, toNext: next ? next.min - karma : 0, share: next ? (karma - level.min) / (next.min - level.min) : 1 };
}
