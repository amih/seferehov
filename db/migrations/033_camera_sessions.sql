-- How each live-camera session went (no pictures): speeds, time spent waiting in each
-- state, photos and how they were taken, how it ended. To set the camera's limits from
-- real shelves. Kept a year.
CREATE TABLE camera_sessions (
  id         bigserial PRIMARY KEY,
  user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('shelf', 'covers', 'stack')),
  ua         text,
  stats      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX camera_sessions_at_idx ON camera_sessions (created_at DESC);
