-- Persist the delegated OAuth grant that authorized a scan, so the async
-- execution path can re-verify the exact grant at run time (W0.4). Additive
-- nullable columns only; existing rows stay NULL (no delegated principal).
ALTER TABLE "Scan" ADD COLUMN "delegatedConnectionId" TEXT;
ALTER TABLE "Scan" ADD COLUMN "delegatedAuthorizationVersion" INTEGER;
