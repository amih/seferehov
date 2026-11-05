-- Web searches made to correct spine readings (server/src/websearch.js): kept so the same
-- query is not sent to the search engines again for 30 days.
CREATE TABLE web_search_cache (
  query text PRIMARY KEY,
  results jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
