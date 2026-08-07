-- Deep Review v12 P0-2: Add PARTIAL to the ScanStatus enum.
--
-- A scan whose engine died mid-run (engine_stopped, content_filter_stopped) but
-- produced at least one finding was previously reported as COMPLETED. That
-- promises "we looked, and this is what we found" when the run was actually
-- truncated — false confidence in a security tool. PARTIAL distinguishes
-- "engine finished its scope and stopped cleanly" (COMPLETED) from "engine
-- stopped early with partial results" (PARTIAL).
--
-- The worker sets PARTIAL when (stoppedForContentFilter || stoppedForEngineError)
-- && hasEngineFindings. Without findings, the scan remains FAILED.
--
-- This is additive: existing COMPLETED scans are not retroactively changed.
-- A future backfill could reclassify historical engine_stopped scans if desired.

ALTER TYPE "ScanStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
