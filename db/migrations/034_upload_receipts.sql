-- Uploads from the phone's outbox carry an id (X-Upload-Id). A repeat (the answer was
-- lost on a weak signal, so the phone sent it again) gets the first answer back instead
-- of being saved twice. Kept 14 days.
CREATE TABLE upload_receipts (
  id         text PRIMARY KEY,
  user_id    bigint,
  status     integer NOT NULL,
  body       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_receipts_at_idx ON upload_receipts (created_at);
