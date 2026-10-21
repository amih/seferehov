-- One of the reader's own books offered for sale or to give away. Only offered books are
-- public, and only with a town (never an address); buyers write through the app and the
-- owner answers by e-mail if they want to.
ALTER TABLE my_books
  ADD COLUMN offer          text CHECK (offer IN ('sale', 'give')),
  ADD COLUMN price          integer CHECK (price BETWEEN 1 AND 100000), -- ₪, sale only
  ADD COLUMN condition      text CHECK (condition IN ('new', 'like_new', 'good', 'fair')),
  ADD COLUMN offer_note     text,
  ADD COLUMN offer_place_id bigint REFERENCES places(id),
  ADD COLUMN offered_at     timestamptz;
CREATE INDEX my_books_offers_idx ON my_books (book_id) WHERE offer IS NOT NULL AND placed_at IS NULL;
CREATE INDEX my_books_offers_recent_idx ON my_books (offered_at DESC) WHERE offer IS NOT NULL AND placed_at IS NULL;

-- The town offered books are in, remembered for the next one.
ALTER TABLE users ADD COLUMN home_place_id bigint REFERENCES places(id);

-- Messages from buyers (kept for limits and abuse checks).
CREATE TABLE offer_messages (
  id          bigserial PRIMARY KEY,
  my_book_id  bigint NOT NULL REFERENCES my_books(id) ON DELETE CASCADE,
  from_user   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offer_messages_from_idx ON offer_messages (from_user, created_at DESC);
