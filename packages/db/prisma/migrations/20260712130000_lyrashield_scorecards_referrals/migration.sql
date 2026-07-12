-- Additive storage for deterministic scores, public scorecards, and referral attribution.
CREATE TYPE "ScoreGrade" AS ENUM ('A_PLUS', 'A', 'B', 'C', 'D', 'F');
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED');

CREATE TABLE "ScoreSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "grade" "ScoreGrade" NOT NULL,
  "breakdown" JSONB NOT NULL,
  "scanMode" "ScanMode" NOT NULL,
  "shareEligible" BOOLEAN NOT NULL DEFAULT false,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScoreSnapshot_scanId_key" ON "ScoreSnapshot"("scanId");
CREATE INDEX "ScoreSnapshot_workspaceId_idx" ON "ScoreSnapshot"("workspaceId");
CREATE INDEX "ScoreSnapshot_targetId_computedAt_idx" ON "ScoreSnapshot"("targetId", "computedAt");
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReferralCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralCode_userId_key" ON "ReferralCode"("userId");
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

CREATE TABLE "ReferralAttribution" (
  "id" TEXT NOT NULL,
  "codeId" TEXT NOT NULL,
  "referredUserId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "ipHash" TEXT,
  "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
  "qualifiedAt" TIMESTAMP(3),
  "rewardRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralAttribution_referredUserId_key" ON "ReferralAttribution"("referredUserId");
CREATE UNIQUE INDEX "ReferralAttribution_rewardRecordId_key" ON "ReferralAttribution"("rewardRecordId");
CREATE INDEX "ReferralAttribution_codeId_idx" ON "ReferralAttribution"("codeId");
CREATE INDEX "ReferralAttribution_status_idx" ON "ReferralAttribution"("status");
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_rewardRecordId_fkey" FOREIGN KEY ("rewardRecordId") REFERENCES "UsageRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ScorecardShare" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "publicPayload" JSONB NOT NULL,
  "referralCodeId" TEXT,
  "createdById" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScorecardShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScorecardShare_slug_key" ON "ScorecardShare"("slug");
CREATE INDEX "ScorecardShare_snapshotId_idx" ON "ScorecardShare"("snapshotId");
ALTER TABLE "ScorecardShare" ADD CONSTRAINT "ScorecardShare_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ScoreSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScorecardShare" ADD CONSTRAINT "ScorecardShare_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
