-- How each book from a scan was read, corrected and verified, one row per piece of
-- evidence, for statistics on which source helps. Joined with scan_items.decision /
-- outcome (approved as read, edited by the reader, declined) it shows which sources gave
-- right answers.
--   stage  read    | how the spine or code was read  (source: barcode, vision, vision+ocr)
--          correct | a change to the reading         (source: frames, web)
--          verify  | a catalogue checked it          (source: local_ol, nli, openlibrary, googlebooks, app…)
--          reader  | the reader's decision          (outcome: kept / edited / dropped; after: the title kept)
--   outcome  read: as_read; correct: corrected / confirmed / unknown / held; verify: match / no_match
CREATE TABLE scan_item_evidence (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES scan_items(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('read', 'correct', 'verify', 'reader')),
  source text NOT NULL,
  outcome text NOT NULL,
  before text,
  after text,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_item_evidence_item_idx ON scan_item_evidence(item_id);
CREATE INDEX scan_item_evidence_source_idx ON scan_item_evidence(stage, source);

-- Per source: how often it acted, and what the reader then did with those books.
CREATE VIEW evidence_by_source AS
SELECT e.stage, e.source, e.outcome,
       count(DISTINCT e.item_id) AS items,
       count(DISTINCT e.item_id) FILTER (WHERE i.decision = 'approved' AND coalesce(i.outcome, 'kept') = 'kept') AS approved_as_is,
       count(DISTINCT e.item_id) FILTER (WHERE i.outcome = 'edited') AS edited_by_reader,
       count(DISTINCT e.item_id) FILTER (WHERE i.decision = 'declined') AS declined,
       count(DISTINCT e.item_id) FILTER (WHERE i.decision IS NULL OR i.decision = 'later') AS waiting
  FROM scan_item_evidence e JOIN scan_items i ON i.id = e.item_id
 GROUP BY 1, 2, 3;
