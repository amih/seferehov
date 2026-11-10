-- Results of the daily server job (server/src/jobs.js), so that no request has to compare
-- every book or every library with each other: duplicate candidates, and per library how
-- many books still need cover photos (and spines no catalogue knew, waiting for covers).
CREATE TABLE IF NOT EXISTS dupe_candidates (
  kind text NOT NULL CHECK (kind IN ('book', 'library')),
  a bigint NOT NULL,
  b bigint NOT NULL,
  why text,
  metres int,
  found_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, a, b)
);
CREATE TABLE IF NOT EXISTS library_needs (
  location_id bigint PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  books int NOT NULL,
  need_covers int NOT NULL,
  open_spines int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
