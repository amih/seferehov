import { t } from './i18n.js';

// The same lists as the server (server/src/genres.js, finder.js PERIODS).
export const GENRES = [
  'novel', 'stories', 'poetry', 'thriller', 'scifi', 'children', 'youth', 'comics',
  'history', 'biography', 'judaism', 'religion', 'philosophy', 'psychology', 'science',
  'health', 'cooking', 'business', 'society', 'art', 'travel', 'reference', 'other',
];
export const LANGUAGES = ['heb', 'eng', 'ara', 'rus', 'fre', 'ger', 'spa', 'ita', 'yid', 'other'];
export const PERIODS = ['old', '1950', '1980', '2000', '2010', '2020'];

// "Novel · Hebrew · 1998", whatever of it is known.
export const bookFacts = (b) => [b.genre && t(`genre.${b.genre}`), b.language && t(`language.${b.language}`), b.year].filter(Boolean).join(' · ');
