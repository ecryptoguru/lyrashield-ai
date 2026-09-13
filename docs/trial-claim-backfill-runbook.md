# Trial claim backfill runbook

`packages/db/scripts/backfill-clear-wrong-trial-claims.ts` clears wrongly stamped `User.trialStartedAt` rows left by the retired fallback that stamped the column for invited members who never received a trial grant.

A candidate is a user whose `trialStartedAt` is set while the account has neither trial marker row (`BillingAccount.provider = "trial"`, `accountId = user.id`) nor trial grant (`UsageRecord.kind = "trial_grant"`, `accountId = user.id`). A marker or grant of any age — even soft-deleted — means the claim was real and the user is skipped.

## Steps

1. Run a dry pass and read the candidate list (ids and created dates only — never emails):

   ```
   DATABASE_SYSTEM_URL=<system-url> pnpm --filter @lyrashield/db exec tsx scripts/backfill-clear-wrong-trial-claims.ts
   ```

2. Review the `candidates` array. Apply with the explicit confirmation flag:

   ```
   DATABASE_SYSTEM_URL=<system-url> pnpm --filter @lyrashield/db exec tsx scripts/backfill-clear-wrong-trial-claims.ts --apply=backfill-clear-wrong-trial-claims
   ```

   A bare `--apply` flag also applies the backfill — the script resolves it to the same confirmation slug. The pinned `--apply=backfill-clear-wrong-trial-claims` spelling is preferred in runbooks and shell history so the intent stays explicit.

3. The apply pass runs in one serializable transaction: each candidate's `trialStartedAt` is cleared and one chained `AuditLog` row (`trial.claim_cleared`, `resourceType: "user"`) is appended in the user's oldest owned workspace. A cleared user who owns no workspace is listed under `unaudited`.

4. Re-run the dry pass — the candidate list should be empty. The script is idempotent.

## Production execution

Production execution is a founder action run from the worker VM with the system database URL — never from a laptop and never under the runtime role. Retain the printed report as the receipt.
