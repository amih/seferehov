-- "I read it", a 1–5 star rating and a review in the reader's own words: one row per
-- reader and book, public under the reader's screen name (book page, reader page).
-- answers: the guided questions, e.g. {"summary": "...", "liked": "...", "recommend_to": "...", "when": "..."}.
CREATE TABLE book_reviews (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    bigint NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  rating     smallint CHECK (rating BETWEEN 1 AND 5),
  answers    jsonb NOT NULL DEFAULT '{}'::jsonb,
  hidden     boolean NOT NULL DEFAULT false, -- by an admin
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, book_id)
);
CREATE INDEX book_reviews_book_idx ON book_reviews (book_id) WHERE NOT hidden;
CREATE INDEX book_reviews_recent_idx ON book_reviews (updated_at DESC);
