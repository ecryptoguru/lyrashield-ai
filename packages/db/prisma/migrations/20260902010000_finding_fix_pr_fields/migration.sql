-- WP3: first-class fix-PR fields on Finding. Both nullable and additive —
-- existing rows keep NULL (no backfill, no rewrite). implicatedFiles is the
-- finding's repo-relative file set (drives the plan-tiered patch-scope
-- allowlist); baseCommit is the commit SHA the implicated scan ran on, the
-- base a fix patch must apply cleanly against.
ALTER TABLE "Finding" ADD COLUMN "implicatedFiles" JSONB;
ALTER TABLE "Finding" ADD COLUMN "baseCommit" TEXT;
