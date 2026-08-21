-- Finding 13: claim approval execution BEFORE side effects.
-- Adds an EXECUTING claim state (winner-only execution) and a terminal
-- EXECUTION_FAILED state after the bounded retry budget is spent, plus a
-- per-approval attempt counter that bounds retries.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
-- PostgreSQL; Prisma automatically detects this statement and runs it outside
-- a transaction. Existing rows are unaffected; new values are appended.

ALTER TYPE "ApprovalStatus" ADD VALUE IF NOT EXISTS 'EXECUTING';
ALTER TYPE "ApprovalStatus" ADD VALUE IF NOT EXISTS 'EXECUTION_FAILED';

ALTER TABLE "AgentApproval" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
