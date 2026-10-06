# Webhook claims production cutover

The ordinary production workflow now refuses to migrate or change production configuration unless every active app/scanner revision and the running worker implement `durable-claims/2`, the claim migration is completed, and the worker's configured rollback image equals its verified running image. The guard runs in the protected `azure-production` job and has no confirmation-string bypass. All active revisions are checked, including zero-traffic revisions reachable through revision URLs.

**The first transition uses the maintenance release.** Current production has legacy writers; ordinary automatic release remains blocked. The protected `Deploy to Azure` dispatch now accepts `webhook_claims_cutover: true` only with the exact current main SHA and `confirmation: webhook-cutover:<source_sha>`. The runtime job retains the `azure-production` environment and the existing global Azure deployment concurrency group. Automatic CI releases cannot choose this mode. Manual production deployment or disabling the guard is not an approved bootstrap mechanism. Founder approval must authorize the app/worker maintenance window. The selected mode does not replace infrastructure readback proof.

The first transition uses the same controlled maintenance workflow, without
separate signing keys or historical review receipts. It checks the actual
legacy scheduling columns after every writer is stopped. If either
`nextAttemptAt` or `leaseExpiresAt` contains a value, migration stops. Complete
or resolve existing work through its normal receipt-aware path; do not clear
schedules to make the check pass. If both values are NULL everywhere, UTC
conversion preserves NULLs without a historical timezone assumption. A partial
UTC schema also stops the release; an already installed complete UTC schema
supports same-run recovery without checking the compatibility shadow columns.

```bash
gh workflow run deploy-azure.yml --ref main \
  -f source_sha="$REVIEWED_MAIN_SHA" \
  -f webhook_claims_cutover=true \
  -f confirmation="webhook-cutover:$REVIEWED_MAIN_SHA"
```

## Release checks

PR CI verifies source and migration contracts. Protected main merges start the
release workflow directly. Azure builds and verifies the digest-pinned worker
once, then repeats the final compatibility and continuity checks before live
promotion. The exact worker image is tested on disposable PostgreSQL and Redis
without production credentials. Cloudflare releases independently, and
Lighthouse measurements run outside the deployment path.

## Implemented maintenance workflow

The protected runtime workflow implements this sequence. Reuse existing queue authority, worker environment parity, stop-provenance capture, Azure helpers and bounded deployment fixtures. Never delete queue keys, replay paid work, reverse additive schema, or infer a drained writer from an empty queue snapshot.

1. Capture immutable currently running app/scanner/worker images and previous traffic. Before claiming admission, verify that the direct migration connection addresses the same logical PostgreSQL host, decoded database name and schema (`public` by default) as both actual old-worker database connections. Different credentials and the deployed direct/pooler ports `5432`/`6432` (or default PostgreSQL port) are permitted, reflecting the existing single-backend Azure topology; unrelated ports are rejected; alias-host, database or schema mismatch fails closed with an operator configuration error. Recheck immediately before migration. Save logical identity hashes alongside full connection hashes. Before claiming admission, compare SHA-256 hashes of the actual running worker's selected `DATABASE_URL`, `DATABASE_SYSTEM_URL` and `REDIS_URL` with the old-image preflight environment. Any mismatch or unreadable identity fails closed without printing credentials. Preserve those hashes in the root-owned receipt and recheck them through shutdown and candidate promotion. Claim the existing owned scan-admission stop. Drain existing nonterminal scans normally and verify zero nonterminal scans and zero wait/active/delayed/prioritized scan and webhook retry jobs using the existing worker preflight. Failure leaves work intact and aborts maintenance. Do not stop a worker that is still executing a paid scan.
2. Block all old webhook ingress by deactivating every incompatible app/scanner revision after the approved maintenance window begins, including zero-traffic active revisions. Finish in-flight handlers. Disable and stop the old worker service gracefully, verify container absence and a fresh root-owned `0600` stop-provenance receipt. Check all old app/scanner revisions inactive immediately before migration. Read the durable track state and retain ambiguous historical/expired claims for receipt review. Do not clear or replay them merely to make preflight green.
3. Only after those checks, apply the additive migration through GitHub Actions. Build/deploy exact compatible app and worker candidates with writer ingress withheld. Verify matching image/source/engine provenance and the `durable-claims/2` implementation; preserve a tested compatible patched fallback. The old production digest is not a valid post-migration writer fallback.
4. Start compatible consumers and promote compatible app/scanner ingress only after both identities and readiness pass. Resume only the stop owned by this run. Read all writer identities back; the ordinary guard must pass before declaring the baseline installed. Perform separately authorized webhook/accounting acceptance; no provider charge/refund is implied by this workflow.
5. On failure after migration, retain schema, accounting/evidence and ingress/consumer maintenance. Restore only a verified compatible fallback. If none exists, remain closed and require operator action. This workflow also holds on pre-migration failures once it has claimed maintenance; it supplies no automatic legacy restoration. Do not use the existing unconditional old-digest rollback path for the first transition.

## Read-only observations for the maintenance workflow

These are concrete existing commands for observer gates, not a manual production deployment procedure. Supply the reviewed resource names through workflow environment variables. Never print the worker environment or credentials.

```bash
az containerapp revision list --name "$AZURE_APP_CONTAINER_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query '[?properties.active==`true`].{name:name,containers:properties.template.containers[].{image:image}}' -o json
az containerapp revision list --name "$AZURE_SCANNER_CONTAINER_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query '[?properties.active==`true`].{name:name,containers:properties.template.containers[].{image:image}}' -o json
```

Immediately before migration both lists must contain no incompatible active writers. The workflow's bounded VM observer must execute:

```bash
systemctl is-active lyrashield-worker.service
# After graceful stop, status must be inactive and the named container absent.
docker ps --filter name=lyrashield-worker --format '{{.Names}}'
stat -c '%U %a %Y' /run/lyrashield/worker-stop-provenance.json
```

Worker stop proof must be tied to the captured exact image/OCI identity and this maintenance run, not only a filename or timestamp. The lifecycle checks stop-receipt freshness and exact previous worker image. Use the existing `ops/worker/capture-stop-provenance.sh` contract. Queue preflight is the established `.github/scripts/promote-worker-vm.sh --preflight` under the exact refreshed worker environment; it must run before shutdown and be combined with ingress/consumer exclusion. SQL inspection of processing/expired claims is read-only; ambiguous domain effects require their existing receipt-aware recovery path.

## Local verification

`node --test .github/scripts/tests/webhook-cutover.test.mjs` covers compatible ordinary release, old ingress, old worker, pending migration, missing identity, mutable image, inactive baseline, mismatched rollback image and failed VM readback. Workflow ordering fixtures prove the guard precedes identity/registry changes, migrations and promotion. `node --test .github/scripts/tests/webhook-maintenance.test.mjs` executes the lifecycle shell and transmitted VM helper with synthetic Redis, queue/database, service and Azure fixtures. It checks owned claim, ingress exclusion, queue/paid-scan refusal, old replica refusal, foreign owner refusal, graceful stop stale database/Redis environment refusal and compatible resume. The existing promoter shell suite covers stopped baseline, durable owner receipt, exact candidate identity, claim protocol and post-migration failure without legacy rollback or admission resume.

These local fixtures do not establish a completed production transition, alert delivery, paid provider acceptance or live sustained Redis capacity. Failed maintenance retains the owned stop and disables app/scanner ingress; it never restores incompatible old writers. A failed or interrupted run must be reviewed before retrying. Use GitHub Actions **Re-run failed jobs** or **Re-run all jobs** on the same run, preserving its original immutable source. The root-owned receipt retains the original owner and nonce, audits each run attempt, and rejects a separate dispatch or different source. A successfully validated original run can recover after main advances only when its durable receipt is proven before production configuration changes; runtime rechecks main independently even when successful validator outputs are reused. Do not delete receipts or admission keys.

The lifecycle persists claim intent before Redis `SET NX`; retry repairs an absent stop only from that exact validated intent. It persists resume intent before compare-delete and completion before archiving the receipt. An uncertain resume acknowledgement is recovered by restoring the exact owned stop before withholding ingress. A compatible candidate digest and its immediately preceding compatible candidate may be retained for same-source rebuild recovery; their source, engine, protocol and database/Redis continuity must pass. Legacy images remain forensic references and are never resumed after cutover.

Azure deactivation [stops all running replicas](https://learn.microsoft.com/en-us/azure/container-apps/revisions-manage); the workflow also reads zero replicas before migration. The inactive scanner revision read-only CLI probe returned zero replicas on 2026-09-30. GitHub [reruns preserve the original SHA and ref](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), which is why same-run receipt recovery is supported without adopting a foreign source.
