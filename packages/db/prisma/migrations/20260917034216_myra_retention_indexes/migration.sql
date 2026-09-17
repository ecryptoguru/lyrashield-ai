-- CreateIndex
CREATE INDEX "demo_bookings_createdAt_idx" ON "demo_bookings"("createdAt");

-- CreateIndex
CREATE INDEX "myra_operations_status_updatedAt_idx" ON "myra_operations"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "support_cases_createdAt_idx" ON "support_cases"("createdAt");
