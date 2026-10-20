-- Two libraries at the same spot: a reviewer keeps one; the other is marked removed and
-- points to it (old links lead there). Pairs checked and found to be two libraries.
ALTER TABLE locations ADD COLUMN merged_into bigint REFERENCES locations(id) ON DELETE SET NULL;

CREATE TABLE location_not_dupes (
  a  bigint NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  b  bigint NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  by_user bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
