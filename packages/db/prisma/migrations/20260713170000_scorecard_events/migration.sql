-- Privacy-safe, allowlisted scorecard funnel events. No target, repository,
-- finding, IP, user-agent, or caption data is stored here.
CREATE TABLE "ScorecardEvent" (
  "id" TEXT NOT NULL,
  "shareId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT '',
  "variant" TEXT NOT NULL DEFAULT 'grade',
  "source" TEXT NOT NULL DEFAULT 'unknown',
  "visitorHash" TEXT NOT NULL,
  "dayBucket" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScorecardEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScorecardEvent_shareId_eventType_channel_visitorHash_dayBuc_key"
  ON "ScorecardEvent"("shareId", "eventType", "channel", "visitorHash", "dayBucket");
CREATE INDEX "ScorecardEvent_shareId_createdAt_idx" ON "ScorecardEvent"("shareId", "createdAt");
CREATE INDEX "ScorecardEvent_eventType_createdAt_idx" ON "ScorecardEvent"("eventType", "createdAt");
ALTER TABLE "ScorecardEvent" ADD CONSTRAINT "ScorecardEvent_shareId_fkey"
  FOREIGN KEY ("shareId") REFERENCES "ScorecardShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;
