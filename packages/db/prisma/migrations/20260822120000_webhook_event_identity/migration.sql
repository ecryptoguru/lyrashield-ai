-- Additive: records how WebhookEvent.externalId was resolved.
-- "delivery" = provider per-delivery event id (Polar webhook-id,
-- Razorpay X-Razorpay-Event-ID); "derived" = deterministic digest of
-- event facts when the provider omits a delivery id. Legacy rows stay
-- NULL (they predate event-level identity and used resource ids).
ALTER TABLE "WebhookEvent" ADD COLUMN "identitySource" TEXT;
