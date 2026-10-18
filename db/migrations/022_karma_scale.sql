-- Karma moves to the new, larger points (config.js POINTS), for what was earned before too.
UPDATE karma_events SET points = CASE reason
  WHEN 'new_location' THEN 100
  WHEN 'sighting_seen' THEN 10
  WHEN 'sighting_added' THEN 10
  WHEN 'sighting_taken' THEN 10
  WHEN 'sighting_gone' THEN 50
  WHEN 'check' THEN 50
  WHEN 'location_edit' THEN 20
  WHEN 'review' THEN 10
  ELSE points END;
CREATE INDEX karma_user_reason_idx ON karma_events (user_id, reason, ref_id);
