-- Reconciliation compares provider object IDs with stored webhook payloads.
-- Keep this read-only lookup indexed without copying sensitive payload fields
-- into a new column. Prisma schema cannot represent partial expression indexes.
-- Production had two WebhookEvent rows at 2026-09-28 readback, so the bounded
-- index build does not need an out-of-band concurrent migration.
CREATE INDEX "WebhookEvent_polar_order_id_reconcile_idx"
  ON "WebhookEvent" ((payload #> '{data,id}'))
  WHERE provider = 'polar' AND "eventType" = 'order.paid';

CREATE INDEX "WebhookEvent_razorpay_payment_id_reconcile_idx"
  ON "WebhookEvent" ((payload #> '{payload,payment,entity,id}'))
  WHERE provider = 'razorpay' AND "eventType" = 'payment.captured';
