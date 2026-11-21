-- One camera from the map (docs/ONE_CAMERA_PLAN.md, 21 Nov 2026): the reader just photographs;
-- the server guesses where (at home, at a known library, at a new library) and the reader checks
-- the guess in the approval queue.
ALTER TABLE capture_sessions
  ADD COLUMN guessed boolean NOT NULL DEFAULT false,  -- opened from the map: no library or owner given
  ADD COLUMN hints jsonb,                              -- what the phone measured (GPS, Wi-Fi, light, time…)
  ADD COLUMN guess jsonb,                              -- { kind, location, confidence, why, candidates }
  ADD COLUMN answer jsonb,                             -- the reader's answer, or { kind, accepted: true }
  ADD COLUMN answered_at timestamptz;

-- The scans a session became, and whether where they go is settled:
--   NULL = settled; 'sure' = a sure guess applied, not yet accepted (the reader may still change it);
--   'ask' = the reader must answer before the books are approved.
ALTER TABLE scans
  ADD COLUMN capture_id uuid REFERENCES capture_sessions(id) ON DELETE SET NULL,
  ADD COLUMN situation text CHECK (situation IN ('sure', 'ask'));
CREATE INDEX scans_capture_idx ON scans(capture_id) WHERE capture_id IS NOT NULL;
