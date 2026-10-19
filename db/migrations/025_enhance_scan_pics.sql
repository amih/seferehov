-- Spine cut-outs and shelf pictures of a scan, sharpened like cover photos. One row per
-- picture handed to Real-ESRGAN (path = the sharpened file, or NULL when it failed);
-- the scan items point at the new files.
CREATE TABLE enhanced_files (
  orig text PRIMARY KEY,
  path text,
  at   timestamptz NOT NULL DEFAULT now()
);
