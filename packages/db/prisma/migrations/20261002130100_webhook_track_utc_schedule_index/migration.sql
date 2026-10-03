CREATE INDEX CONCURRENTLY "WebhookEventTrack_status_nextAttemptAtUtc_idx"
  ON "WebhookEventTrack" (status, "nextAttemptAtUtc");
