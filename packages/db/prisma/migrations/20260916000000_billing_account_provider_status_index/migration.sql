-- CreateIndex
CREATE INDEX "BillingAccount_provider_status_deletedAt_idx" ON "BillingAccount"("provider", "status", "deletedAt");
