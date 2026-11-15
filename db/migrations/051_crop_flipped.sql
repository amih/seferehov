-- The reader turned this spine's cut-out the right way up when approving it (queue: "Approve, turned").
-- crop_path is the turned picture; crop_unflipped the one the scan made (upside down: kept as an
-- example for a model that tells upside-down spines, and put back by "undo").
ALTER TABLE scan_items ADD COLUMN crop_unflipped text;
