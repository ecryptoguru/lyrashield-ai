-- Commit 9: enforce authenticated monotonic evidence sync
-- Additive migration: add monotonic sequence to SyncCursor for CAS replay protection
-- Existing rows start at seq=0 (default), new batches increment atomically within transaction.

ALTER TABLE "SyncCursor" ADD COLUMN "seq" BIGINT NOT NULL DEFAULT 0;

CREATE INDEX "SyncCursor_seq_idx" ON "SyncCursor"("seq");
