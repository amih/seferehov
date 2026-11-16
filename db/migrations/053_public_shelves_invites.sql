-- A home library stays private unless the reader makes a book, or a whole shelf photo,
-- public (16 Nov 2026). Public books show on the reader's page and on the book's page with
-- the reader's screen name and town (users.home_place_id), never an address.
ALTER TABLE my_books ADD COLUMN public boolean NOT NULL DEFAULT false,
                     ADD COLUMN public_at timestamptz;
ALTER TABLE scans ADD COLUMN public boolean NOT NULL DEFAULT false,
                  ADD COLUMN public_at timestamptz;
CREATE INDEX my_books_public_idx ON my_books(book_id) WHERE public;

-- Invite links: /?i=<code>. A plain invite (friend_name and books empty) is the reader's
-- own link, used again and again. A handover link also carries the books the reader
-- catalogued at a friend's home (invite_books): the friend accepts them into their own
-- My books, once, before expires_at.
CREATE TABLE invites (
  id           bigserial PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handover     boolean NOT NULL DEFAULT false,
  friend_name  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  accepted_by  bigint REFERENCES users(id) ON DELETE SET NULL,
  accepted_at  timestamptz,
  declined_at  timestamptz
);
CREATE INDEX invites_user_idx ON invites(user_id, created_at DESC);
CREATE UNIQUE INDEX invites_plain_uq ON invites(user_id) WHERE NOT handover;

CREATE TABLE invite_books (
  invite_id   bigint NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
  my_book_id  bigint NOT NULL REFERENCES my_books(id) ON DELETE CASCADE,
  PRIMARY KEY (invite_id, my_book_id)
);

-- Who invited whom: the inviter gets points once, at the new reader's first contribution.
ALTER TABLE users ADD COLUMN invited_by bigint REFERENCES users(id) ON DELETE SET NULL,
                  ADD COLUMN invite_id bigint REFERENCES invites(id) ON DELETE SET NULL;
