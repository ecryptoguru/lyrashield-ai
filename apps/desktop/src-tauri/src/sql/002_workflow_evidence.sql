-- LyraShield Local — SQLite schema v2
-- Workflow/backend provenance on scans and the richer engine evidence
-- projection on findings (run.json 1.1 fields). Additive only: every column
-- is nullable or defaulted so v1 rows stay readable and missing data remains
-- unknown (NULL), never guessed.

ALTER TABLE scans ADD COLUMN workflow TEXT NOT NULL DEFAULT 'REVIEW_TARGET';
ALTER TABLE scans ADD COLUMN backend TEXT NOT NULL DEFAULT 'local';
ALTER TABLE scans ADD COLUMN diff_base TEXT;
ALTER TABLE scans ADD COLUMN diff_head TEXT;
ALTER TABLE scans ADD COLUMN contract_version TEXT;

ALTER TABLE findings ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'DETECTED';
ALTER TABLE findings ADD COLUMN evidence_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN counterevidence TEXT;
ALTER TABLE findings ADD COLUMN confidence_rationale TEXT;
ALTER TABLE findings ADD COLUMN fix_verification TEXT;
ALTER TABLE findings ADD COLUMN http_exchange_ids TEXT;
