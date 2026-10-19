-- Cover photos sharpened by Real-ESRGAN for showing. orig_path keeps the photo as it
-- was (after cropping): the cover text is read from that, never from the sharpened one.
ALTER TABLE photos ADD COLUMN enhanced_at timestamptz, ADD COLUMN orig_path text;
