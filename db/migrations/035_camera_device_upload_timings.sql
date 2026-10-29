-- Camera sessions now carry the phone (model, system and browser versions, screen,
-- cores, memory, network, graphics chip) and the camera actually given (size, frame
-- rate, focus, zoom, photo sizes), with a session id that the uploads also carry. The
-- barcode camera is logged too.
ALTER TABLE camera_sessions DROP CONSTRAINT camera_sessions_kind_check;
ALTER TABLE camera_sessions ADD CONSTRAINT camera_sessions_kind_check CHECK (kind IN ('shelf', 'covers', 'stack', 'barcode'));
ALTER TABLE camera_sessions ADD COLUMN sid text, ADD COLUMN device jsonb, ADD COLUMN camera jsonb;
CREATE INDEX camera_sessions_sid_idx ON camera_sessions (sid);

-- Each upload from the phone's outbox: how long it waited on the phone (taken → sent,
-- client clock), how long the upload took (client), how long the server took, tries,
-- size, network, and what it became (scan / book / sighting id). Kept a year.
CREATE TABLE upload_timings (
  id          text PRIMARY KEY,           -- the outbox id (X-Upload-Id)
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  cam_session text,                       -- camera_sessions.sid
  label       text,
  path        text,
  status      integer,
  bytes       bigint,
  files       integer,
  tries       integer,
  sender      text,                       -- page | sw (service worker)
  net         text,                       -- effectiveType/downlink/rtt when sent
  queued_ms   bigint,                     -- stored on the phone → this try sent
  held_ms     bigint,                     -- last photo added → this try sent
  client_ms   integer,                    -- this try: sent → answer (phone)
  server_ms   integer,                    -- request handled (server)
  result      jsonb,                      -- { scan, book, sighting, error }
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_timings_at_idx ON upload_timings (created_at DESC);
CREATE INDEX upload_timings_session_idx ON upload_timings (cam_session);
