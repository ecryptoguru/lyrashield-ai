-- Fixed-width UTC keys make timestamp text ordering chronological even when
-- legacy RFC3339 rows use mixed fractional precision or explicit offsets.
ALTER TABLE scans ADD COLUMN started_at_sort TEXT;
CREATE INDEX IF NOT EXISTS idx_scans_started_at_sort
    ON scans(started_at_sort DESC, scan_id DESC);
