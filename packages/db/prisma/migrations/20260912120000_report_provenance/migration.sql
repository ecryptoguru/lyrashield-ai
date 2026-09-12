-- Additive: launch_readiness reports gain a private issue-time provenance
-- record (bound GateVerdict, assessed release identity, applicability outcome
-- at issue). Nullable so preexisting Report rows remain valid and the prior
-- deployed application keeps working during rollout.

ALTER TABLE "Report" ADD COLUMN "provenanceJson" JSONB;
