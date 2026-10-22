// Genres and languages of books, for browsing and filtering search results. Catalogues
// seldom give a genre (and never for most Hebrew books), so the local model picks one
// from a fixed list, from the title, authors, publisher and description, one book at a
// time while the GPU has nothing else to do (ocr.js). A missing language is guessed from
// the script of the title (Hebrew, Arabic, Cyrillic), or by the model for Latin titles.
import { config } from './config.js';
import { one, q } from './db.js';

export const GENRES = [
  'novel', 'stories', 'poetry', 'thriller', 'scifi', 'children', 'youth', 'comics',
  'history', 'biography', 'judaism', 'religion', 'philosophy', 'psychology', 'science',
  'health', 'cooking', 'business', 'society', 'art', 'travel', 'reference', 'other',
];
const DESCRIBE = {
  novel: 'novel / literary fiction', stories: 'short stories', poetry: 'poetry', thriller: 'mystery, crime or thriller',
  scifi: 'science fiction or fantasy', children: "children's book (up to ~10)", youth: 'young adult / teen', comics: 'comics or graphic novel',
  history: 'history', biography: 'biography or memoir', judaism: 'Judaism, Jewish law, Torah, prayer', religion: 'other religion or spirituality',
  philosophy: 'philosophy', psychology: 'psychology, self-help, parenting', science: 'science, nature, technology, math',
  health: 'health, fitness, diet', cooking: 'cooking', business: 'business, economics, money', society: 'politics, society, current affairs',
  art: 'art, music, photography, design', travel: 'travel, places, guides', reference: 'dictionary, textbook, study book, reference', other: 'none of these',
};
export const LANGUAGES = ['heb', 'eng', 'ara', 'rus', 'fre', 'ger', 'spa', 'ita', 'yid', 'other'];

export function scriptLanguage(text) {
  const s = String(text ?? '');
  const count = (re) => (s.match(re) ?? []).length;
  const heb = count(/[֐-׿]/g), ara = count(/[؀-ۿ]/g), cyr = count(/[Ѐ-ӿ]/g), lat = count(/[A-Za-z]/g);
  const top = Math.max(heb, ara, cyr, lat);
  if (!top) return null;
  return top === heb ? 'heb' : top === ara ? 'ara' : top === cyr ? 'rus' : 'latin';
}

const PROMPT = (b, askLang) => `Classify this book into exactly one genre from the list.
Title: ${b.title}
Authors: ${(b.authors ?? []).join(', ') || 'unknown'}${b.publisher ? `\nPublisher: ${b.publisher}` : ''}${b.year ? `\nYear: ${b.year}` : ''}${b.description ? `\nDescription: ${b.description.slice(0, 700)}` : ''}

Genres:
${GENRES.map((g) => `${g}: ${DESCRIBE[g]}`).join('\n')}

Answer one line: GENRE${askLang ? ' | LANGUAGE (the language the book is written in, a code: eng, fre, ger, spa, ita or other)' : ''}`;

async function ask(prompt) {
  const res = await fetch(`${config.vision.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.vision.model, prompt, stream: false, think: false, keep_alive: '3m',
      options: { num_ctx: 4096, num_predict: 20, temperature: 0 } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}`);
  return (await res.json()).response ?? '';
}

// The genre (and missing language) of one book; false when none is left to do.
export async function classifyNext() {
  const b = await one(`SELECT id, title, authors, publisher, year, description, language FROM books
                        WHERE genre_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  if (!b) return false;
  const script = b.language ? null : scriptLanguage(b.title);
  // Common English words settle a Latin-script title; the model guesses the rest.
  const english = script === 'latin' && /\b(the|of|and|in|to|for|with|on|an|how|what|my|your|is)\b/i.test(b.title) ? 'eng' : null;
  const askLang = script === 'latin' && !english;
  const answer = (await ask(PROMPT(b, askLang))).toLowerCase();
  const [g, l] = answer.split('|').map((s) => s.trim().replace(/[^a-z]/g, ''));
  const genre = GENRES.includes(g) ? g : null;
  const language = b.language ?? english ?? (askLang ? (LANGUAGES.includes(l) ? l : null) : script === 'latin' ? null : script);
  await q('UPDATE books SET genre = COALESCE($2, genre), language = COALESCE(language, $3), genre_at = now() WHERE id = $1', [b.id, genre, language]);
  return true;
}
