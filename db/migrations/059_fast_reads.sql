-- The fast spine reader (lab 065 A5, Qwen3-VL 2B + LoRA; the admin approved it for the app on 26 Nov 2026): one row
-- per spine cut-out it read, kept to measure whether it really helps. A batch is one GPU lease (all cut-outs of a
-- scan's photos, or of one photo).
CREATE TABLE IF NOT EXISTS fast_read_batches (
  id          bigserial PRIMARY KEY,
  scan_id     uuid,
  model       text,
  cutouts     integer NOT NULL,          -- cut-outs sent (each read both ways up: 2 pictures)
  wall_ms     integer,                   -- from asking for the GPU to the answers, everything included
  load_s      real,                      -- loading the model onto the card
  read_s      real,                      -- reading, after loading
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fast_reads (
  id           bigserial PRIMARY KEY,
  batch_id     bigint REFERENCES fast_read_batches(id) ON DELETE SET NULL,
  scan_id      uuid,
  item_id      bigint REFERENCES scan_items(id) ON DELETE SET NULL,  -- the queue item the cut-out became, if any
  frame        integer,                  -- photo index in the scan (0-based)
  cutout       integer,                  -- cut-out index in the photo (spine cutter order)
  texts        jsonb,                    -- A5's raw answer for each way up: {"270": "...", "90": "NONE"}
  angle        integer,                  -- the way up whose reading was used for the gate
  title        text,                     -- A5's reading
  author       text,
  hebrew       boolean,                  -- a Hebrew reading (A5 reads Latin badly: 28.6%; FAST_READER_SCRIPTS=hebrew settles only these)
  confirmed_by text,                     -- 'local' | 'nli' | null: the catalogue that knows the reading
  cat_title    text,                     -- the catalogue's title for it
  settled      boolean NOT NULL DEFAULT false,  -- the catalogue confirmed the reading
  shadow       boolean NOT NULL DEFAULT false,  -- settled, but Qwen 8B read it anyway (a sample, to compare)
  used         text,                     -- 'fast' (A5's reading kept, Qwen skipped) | 'qwen' (today's path)
  ocr_ok       boolean,                  -- for 'fast': the Hebrew PaddleOCR found the reading on the cut-out
  qwen_title   text,                     -- what today's path read, when it ran
  qwen_author  text,
  qwen_verified boolean,
  qwen_calls   integer,                  -- vision-model calls today's path made for this cut-out
  fast_s       real,                     -- A5 seconds for this cut-out (both ways up)
  gate_ms      integer,                  -- catalogue check
  qwen_ms      integer,                  -- today's path for this cut-out, when it ran
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fast_reads_scan ON fast_reads (scan_id);
CREATE INDEX IF NOT EXISTS fast_reads_item ON fast_reads (item_id) WHERE item_id IS NOT NULL;
