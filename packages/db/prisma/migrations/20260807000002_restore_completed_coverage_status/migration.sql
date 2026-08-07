-- Restore COMPLETED in ScanCoverageStatus enum (schema drift fix).
--
-- The original migration (20260714200000) created the enum with COMPLETED.
-- The Prisma schema was later edited to replace COMPLETED with PARTIAL, but
-- no migration was created for that change — the database still has COMPLETED.
-- This caused a type mismatch: the engine writes "COMPLETED" receipts, the
-- database accepts them, but Prisma's generated types excluded "COMPLETED".
--
-- This migration adds COMPLETED back to the enum (idempotent) so the schema
-- and database agree. PARTIAL is also kept for future use.

ALTER TYPE "ScanCoverageStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "ScanCoverageStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
