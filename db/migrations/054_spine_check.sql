-- /admin/spine-check: the admin's answer for each cut-out the lab is unsure how to tag (lab experiment 045).
-- What is wrong with the cut-out, so the lab knows which ones to cut again and which to set aside.
CREATE TABLE spine_check_answers (
  item_id integer PRIMARY KEY REFERENCES scan_items(id) ON DELETE CASCADE,
  answer text NOT NULL,
  guess text,
  at timestamptz NOT NULL DEFAULT now()
);
