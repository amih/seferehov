-- Help check (Ami, 24 Nov 2026): books that wait unchecked in their photographer's queue,
-- from photos at public street libraries, can be checked by any signed-in volunteer
-- (server/src/help.js). One vote per volunteer per book: true = "this is the book in the picture".
CREATE TABLE help_votes (
  item_id    bigint NOT NULL REFERENCES scan_items(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote       boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX help_votes_user_idx ON help_votes(user_id, created_at DESC);

-- Who decided a book: NULL = its photographer (or the server, auto); else the volunteer whose
-- vote settled it. help_off: the photographer undid the volunteers' decision, so the book is
-- not offered for checking again.
ALTER TABLE scan_items
  ADD COLUMN decided_by bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN help_off boolean NOT NULL DEFAULT false;
