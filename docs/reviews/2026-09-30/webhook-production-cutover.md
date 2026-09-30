# Webhook claims production cutover

The ordinary production workflow now refuses to migrate or change production configuration unless every active app/scanner revision and the running worker implement `durable-claims/1`, the claim migration is completed, and the worker's configured rollback image equals its verified running image. The guard runs in the protected `azure-production` job and has no confirmation-string bypass. All active revisions are checked, including zero-traffic revisions reachable through revision URLs.

**The first transition is deliberately blocked. It is not production ready yet.** Current production has legacy writers. A separate reviewed GitHub Actions maintenance transition is still required; manual production deployment or disabling the guard is not an approved bootstrap mechanism. Founder approval must authorize the app/worker maintenance window through the protected deployment mechanism. Approval chooses the maintenance operation; infrastructure readback must independently prove its safety.

## Required maintenance workflow

Implement the following sequence in that reviewed workflow. Reuse existing queue authority, worker environment parity, stop-provenance capture, Azure helpers and bounded deployment fixtures. Never delete queue keys, replay paid work, reverse additive schema, or infer a drained writer from an empty queue snapshot.

1. Capture immutable currently running app/scanner/worker images and previous traffic. Claim the existing owned scan-admission stop. Drain existing nonterminal scans normally and verify zero nonterminal scans and zero wait/active/delayed/prioritized scan and webhook retry jobs using the existing worker preflight. Failure leaves work intact and aborts maintenance. Do not stop a worker that is still executing a paid scan.
2. Block all old webhook ingress by deactivating every incompatible app/scanner revision after the approved maintenance window begins, including zero-traffic active revisions. Finish in-flight handlers. Stop the old worker service gracefully, verify container absence and a fresh root-owned `0600` stop-provenance receipt. Check all old app/scanner revisions inactive immediately before migration. Read the durable track state and retain ambiguous historical/expired claims for receipt review. Do not clear or replay them merely to make preflight green.
3. Only after those checks, apply the additive migration through GitHub Actions. Build/deploy exact compatible app and worker candidates with writer ingress withheld. Verify matching image/source/engine provenance and the `durable-claims/1` implementation; preserve a tested compatible patched fallback. The old production digest is not a valid post-migration writer fallback.
4. Start compatible consumers and promote compatible app/scanner ingress only after both identities and readiness pass. Resume only the stop owned by this run. Read all writer identities back; the ordinary guard must pass before declaring the baseline installed. Perform separately authorized webhook/accounting acceptance; no provider charge/refund is implied by this workflow.
5. On failure after migration, retain schema, accounting/evidence and ingress/consumer maintenance. Restore only a verified compatible fallback. If none exists, remain closed and require operator action. Before-migration restoration is allowed only when no compatible writer or new-generation state was activated and old state is proven unchanged. Do not use the existing unconditional old-digest rollback path for the first transition.

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

Worker stop proof must be tied to the captured exact image/OCI identity and this maintenance run, not only a filename or timestamp. Use the existing `ops/worker/capture-stop-provenance.sh` contract. Queue preflight is the established `.github/scripts/promote-worker-vm.sh --preflight` under the exact refreshed worker environment; it must run before shutdown and be combined with ingress/consumer exclusion. SQL inspection of processing/expired claims is read-only; ambiguous domain effects require their existing receipt-aware recovery path.

## Local verification

`node --test .github/scripts/tests/webhook-cutover.test.mjs` covers compatible ordinary release, old ingress, old worker, pending migration, missing identity, mutable image, inactive baseline, mismatched rollback image and failed VM readback. Workflow ordering fixtures prove the guard precedes identity/registry changes, migrations and promotion. These tests do not establish a completed production transition or certify the future maintenance workflow.
