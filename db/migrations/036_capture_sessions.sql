-- Free-style capture (web/src/capture.js → server/src/capture.js): the phone sends every
-- photo of a session as it is taken, in order, with the time and how the phone moved;
-- the server sorts them into shelves, front covers and back covers, pairs the covers
-- into books (pairing.js) and makes the usual scans of them.
CREATE TABLE capture_sessions (
  id           uuid PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id  bigint REFERENCES locations(id) ON DELETE CASCADE,  -- NULL = My books
  kind         text NOT NULL DEFAULT 'seen' CHECK (kind IN ('seen', 'added')),
  lang         text NOT NULL DEFAULT 'he',
  owner        text,
  friend_name  text,
  distance_m   integer,
  expected     integer,              -- photos taken, said by the phone when the camera closed
  ended_at     timestamptz,
  last_shot_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sorting', 'done', 'failed')),
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sorted_at    timestamptz
);
CREATE INDEX capture_sessions_open_idx ON capture_sessions (last_shot_at) WHERE status = 'open';

CREATE TABLE capture_shots (
  session_id  uuid NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  taken_ms    integer,               -- ms since the camera opened
  meta        jsonb NOT NULL DEFAULT '{}',
  path        text NOT NULL,
  kind        text,                  -- shelf | front | back | other, once sorted
  scan_id     uuid REFERENCES scans(id) ON DELETE SET NULL,
  sorted_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

ALTER TABLE camera_sessions DROP CONSTRAINT camera_sessions_kind_check;
ALTER TABLE camera_sessions ADD CONSTRAINT camera_sessions_kind_check CHECK (kind IN ('shelf', 'covers', 'stack', 'barcode', 'capture'));
