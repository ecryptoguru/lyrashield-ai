-- Durable bounded receipts for authentic provider webhook deliveries that
-- failed catalog validation. Identifiers and reason codes only — no payload,
-- emails, secrets, or tenant binding. Tenant runtime roles must not read or
-- write rejection receipts; the worker/web ingress writes through the system
-- role only.
CREATE TABLE "WebhookEventRejection" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "identitySource" TEXT,
  "eventType" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEventRejection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookEventRejection_bounded_fields_check" CHECK (
    length("provider") <= 32
    AND length("externalId") BETWEEN 1 AND 256
    AND length("eventType") <= 128
    AND length("reasonCode") BETWEEN 1 AND 64
    AND ("identitySource" IS NULL OR "identitySource" IN ('delivery', 'derived'))
  )
);

-- Rejected replays dedupe on the same identity as accepted receipts, without
-- ever overlaying a WebhookEvent row.
CREATE UNIQUE INDEX "WebhookEventRejection_provider_externalId_key"
  ON "WebhookEventRejection" ("provider", "externalId");
CREATE INDEX "WebhookEventRejection_provider_observedAt_idx"
  ON "WebhookEventRejection" ("provider", "observedAt");

ALTER TABLE "WebhookEventRejection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEventRejection" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "WebhookEventRejection" FROM PUBLIC;

CREATE POLICY "WebhookEventRejection_system_only"
  ON "WebhookEventRejection"
  FOR ALL
  USING (current_user = 'app_system_prod')
  WITH CHECK (current_user = 'app_system_prod');

DO $webhook_event_rejection_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod') THEN
    REVOKE ALL PRIVILEGES ON TABLE "WebhookEventRejection" FROM app_runtime_prod;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system_prod') THEN
    GRANT SELECT, INSERT ON TABLE "WebhookEventRejection" TO app_system_prod;
  END IF;
END
$webhook_event_rejection_grants$;
