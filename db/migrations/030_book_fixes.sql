-- Readers' corrections to a book: a misread title or author, the publisher, the year, the
-- blurb, or the text read from a cover photo (photo_id). Every change is kept, so any can
-- be undone. A fix goes live at once when its author is trusted enough, otherwise once
-- other readers' votes (book_fix_votes) accept it.
--   pending → live (accepted) → superseded (a later fix of the same thing went live)
--                             → reverted (undone by someone else) / withdrawn (by its author)
--   pending → rejected
CREATE TABLE book_fixes (
  id           bigserial PRIMARY KEY,
  book_id      bigint NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  field        text NOT NULL CHECK (field IN ('title', 'authors', 'publisher', 'year', 'description', 'cover_text')),
  photo_id     uuid REFERENCES photos(id) ON DELETE CASCADE,
  old_value    text,
  new_value    text,
  note         text,
  reverts      bigint REFERENCES book_fixes(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'live', 'superseded', 'reverted', 'withdrawn', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   bigint REFERENCES users(id) ON DELETE SET NULL,
  kept_awarded boolean NOT NULL DEFAULT false,
  CHECK ((field = 'cover_text') = (photo_id IS NOT NULL))
);
CREATE INDEX book_fixes_book_idx ON book_fixes(book_id, created_at DESC);
CREATE INDEX book_fixes_user_idx ON book_fixes(user_id, created_at DESC);
CREATE INDEX book_fixes_pending_idx ON book_fixes(created_at) WHERE status = 'pending';
CREATE INDEX book_fixes_kept_idx ON book_fixes(decided_at) WHERE status IN ('live', 'superseded') AND NOT kept_awarded;

CREATE TABLE book_fix_votes (
  fix_id     bigint NOT NULL REFERENCES book_fixes(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote       smallint NOT NULL CHECK (vote IN (-1, 1)),
  weight     smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fix_id, user_id)
);
CREATE INDEX book_fix_votes_user_idx ON book_fix_votes(user_id);

-- Fields a reader fixed: the monthly catalogue refresh leaves them alone.
ALTER TABLE books ADD COLUMN fixed_fields text[] NOT NULL DEFAULT '{}';
