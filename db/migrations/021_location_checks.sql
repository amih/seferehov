-- A visit to a library: what state it is in. The latest one shows on its page.
CREATE TABLE location_checks (
  id           bigserial PRIMARY KEY,
  location_id  bigint NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  state        text NOT NULL CHECK (state IN ('ok', 'messy', 'damaged', 'empty', 'missing')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_checks_loc_idx ON location_checks (location_id, created_at DESC);
