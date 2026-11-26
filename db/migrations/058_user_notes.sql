-- Notes for one reader, shown on one screen until they say "done" (26 Nov 2026: the admin's reminder of
-- lab test 074, shelf photos at 4 distances). "Later" hides a note for a day.
CREATE TABLE IF NOT EXISTS user_notes (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  screen      text NOT NULL DEFAULT 'camera',
  text_he     text NOT NULL,
  text_en     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  later_until timestamptz,
  done_at     timestamptz
);
CREATE INDEX IF NOT EXISTS user_notes_open ON user_notes (user_id, screen) WHERE done_at IS NULL;
