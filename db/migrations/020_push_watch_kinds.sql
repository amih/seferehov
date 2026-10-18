-- Phone notifications (Web Push), per-reader notification choices, and alerts for an
-- author or for words, not only for one book.
CREATE TABLE push_subs (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subs_user_idx ON push_subs (user_id);

ALTER TABLE users ADD COLUMN notify_email boolean NOT NULL DEFAULT true,
                  ADD COLUMN notify_push  boolean NOT NULL DEFAULT true;

-- kind book = book_id; author / words = query (search_norm'ed).
ALTER TABLE book_watches ADD COLUMN kind text NOT NULL DEFAULT 'book' CHECK (kind IN ('book', 'author', 'words')),
                         ADD COLUMN query text,
                         ALTER COLUMN book_id DROP NOT NULL,
                         ADD CONSTRAINT book_watches_kind_ck CHECK ((kind = 'book') = (book_id IS NOT NULL) AND (kind = 'book') = (query IS NULL));
CREATE UNIQUE INDEX book_watches_query_uq ON book_watches (user_id, kind, query) WHERE query IS NOT NULL;
