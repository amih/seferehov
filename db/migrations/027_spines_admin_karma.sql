-- Covers photographed for a spine read at a library but found in no catalogue, maybe by
-- another reader on a later visit: the cover scan remembers which spine it answers.
ALTER TABLE scans ADD COLUMN replaces_item bigint REFERENCES scan_items(id) ON DELETE SET NULL;
-- Admins earn a tenth of the points (they need no encouragement, and should not top the
-- board): what they earned before is scaled down too.
UPDATE karma_events k SET points = GREATEST(1, round(k.points / 10.0))
  FROM users u WHERE u.id = k.user_id AND u.trust_level >= 3 AND k.points > 0;
