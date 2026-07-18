-- Retain provider-reported usage separately from the amount billed under the
-- server-enforced scan cap. Token counters make provider reconciliation
-- possible without storing prompts, responses, or per-request payloads.
ALTER TABLE "Scan"
ADD COLUMN "providerCostUsd" DECIMAL(12, 6),
ADD COLUMN "billedCostUsd" DECIMAL(12, 6),
ADD COLUMN "llmRequestCount" INTEGER,
ADD COLUMN "llmInputTokens" INTEGER,
ADD COLUMN "llmCachedInputTokens" INTEGER,
ADD COLUMN "llmOutputTokens" INTEGER;
