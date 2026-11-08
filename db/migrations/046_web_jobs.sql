-- Web checks that could not be searched when the scan was read (every engine resting or its
-- daily share used): run later, slowly, faster at night (server/src/webqueue.js).
CREATE TABLE web_jobs (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES scan_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('spine', 'cover')),
  steps text[] NOT NULL,          -- which searches were held: web, author, blurb
  payload jsonb NOT NULL,         -- title, author, cover text, blurb
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE INDEX web_jobs_waiting ON web_jobs (run_after) WHERE status = 'waiting';
CREATE UNIQUE INDEX web_jobs_one_per_item ON web_jobs (item_id) WHERE status = 'waiting';
