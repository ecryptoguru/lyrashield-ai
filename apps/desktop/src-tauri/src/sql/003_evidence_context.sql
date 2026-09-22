-- Additive local result projection. NULL means an older scan did not record
-- this evidence; it must never be interpreted as a negative finding.
ALTER TABLE findings ADD COLUMN evidence_context TEXT;
ALTER TABLE scans ADD COLUMN threat_model_available INTEGER;
