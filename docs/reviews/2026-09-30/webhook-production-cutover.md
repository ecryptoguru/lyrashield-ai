# Webhook claims production cutover

The ordinary production workflow now refuses to migrate or change production configuration unless every active app/scanner revision and the running worker implement `durable-claims/2`, the claim migration is completed, and the worker's configured rollback image equals its verified running image. The guard runs in the protected `azure-production` job and has no confirmation-string bypass. All active revisions are checked, including zero-traffic revisions reachable through revision URLs.

**The first transition requires a separately authorized maintenance release.** Current production has legacy writers; ordinary automatic release remains blocked. The protected `Deploy to Azure` dispatch now accepts `webhook_claims_cutover: true` only with the exact current main SHA and `confirmation: webhook-cutover:<source_sha>`. The runtime job retains the `azure-production` environment and the existing global Azure deployment concurrency group. Automatic CI releases cannot choose this mode. Manual production deployment or disabling the guard is not an approved bootstrap mechanism. Founder approval must authorize the app/worker maintenance window. The selected mode does not replace infrastructure readback proof.

Before dispatch, configure the `azure-production` GitHub Environment secrets `WEBHOOK_LEGACY_TIMEZONE_REVIEW_PUBLIC_KEY_PEM` and `WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT`. The deployment validates the detached Ed25519 signature, current source SHA, review age (30 days), UTC assertion and a SHA-256 logical database identity before Azure login or any maintenance claim. The receipt must refer to the evidence used to establish how pre-cutover timestamp values were written; code and a fresh migration do not establish that historical fact. The migration database URL is read only to calculate its host/database/schema identity and is never printed.

Keep the Ed25519 private key in the operator's approved signing store, outside the repository. Configure only its PEM public key in the protected Environment. Compute the migration target identity without printing its connection string:

```bash
MIGRATION_DATABASE_URL="$DATABASE_DIRECT_URL" node .github/scripts/migration-database-identity.mjs
```

For the exact reviewed main SHA, build the payload in this property order: `schemaVersion` (`webhook-timezone-review/v1`), `sourceSha`, `legacyTimezone` (`UTC`), `reviewedAt` (ISO-8601 with timezone), `evidenceRef` (an HTTPS or GitHub Actions run reference), `reviewer` (operator identifier) and `databaseIdentitySha256` (the command output above). Sign the UTF-8 bytes of `JSON.stringify(payload)` using Ed25519 and store the base64 signature as the `signature` property. Put the resulting JSON in `WEBHOOK_LEGACY_TIMEZONE_REVIEW_RECEIPT`. The receipt and key are protected Environment configuration; do not commit them or paste the private key into a workflow input. The validator emits only a generic pass/fail and never prints the receipt or database URL. A changed source, database, key, timestamp interpretation or receipt requires a newly signed receipt.

Example for the authorized operator, after merge and review of the exact main SHA:

```bash
gh workflow run deploy-azure.yml --ref main \
  -f source_sha="$REVIEWED_MAIN_SHA" \
  -f webhook_claims_cutover=true \
  -f confirmation="webhook-cutover:$REVIEWED_MAIN_SHA"
```

This command dispatches a production maintenance window; it was not executed during source preparation. The first dispatch independently confirms current main. A foreign or concurrent owner receipt fails closed rather than being silently reclaimed.

## Automatic release preflight and exact image proof

When Azure production resources are configured, automatic and normal manual releases run the read-only webhook compatibility check before any image build or registry push. The first-cutover dispatch validates the signed historical UTC receipt and the logical database identity at the same early stage. An early preflight failure leaves the production deployment steps unstarted and avoids publishing images for a known-blocked release. The runtime job repeats its original final compatibility and continuity checks after the build; the early read is a cost-saving preflight, not a replacement for the final check.

Each release worker image is now exercised by digest against disposable PostgreSQL and Redis before the Azure deployment job can start. This is separate from main CI and from tests against another image tag or source SHA. The protected **Verify webhook production prerequisites without deployment** workflow is manually discoverable in GitHub Actions. Run it from the exact current `main` to validate the owner-provided receipt; optionally supply all three worker fields together (product source SHA and engine revision plus `ghcr.io/...@sha256:...`) to rehearse that exact image on disposable services. It has no Azure identity permission and performs no production writes. The workflow does not automatically fail on every main CI run when one-time evidence has not yet been supplied.

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
