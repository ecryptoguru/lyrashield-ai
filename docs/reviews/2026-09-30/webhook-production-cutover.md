# Webhook claims production cutover

The production release classifies the baseline before building images and
repeats the same read-only check in the runtime job before any production
configuration or migration mutation. A fully verified `durable-claims/2`
baseline selects the ordinary release. The first transition is selected only
when every active app/scanner revision and the running worker have immutable
source/image provenance matching a complete role-specific tuple in the
[reviewed legacy image profiles](../2026-10-07/webhook-legacy-image-profile.md).
The profiles bind exact source revisions
`4822306e24f375800981bf282fd992a9c15dcde8` and
`3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530` to their respective published
web/scanner and worker digests, with pinned engine
`9d90be5aaf92f86bb5c1ba55a8138545764fdd44`. Each active writer is validated
independently; reviewed revisions may coexist when every source/digest pair
matches. The worker must match its entire source/engine/digest tuple.
The two prerequisite migration checksums must match and the selected `public`
schema must have the exact legacy column, default, index and constraint catalog.
The four later transition migrations must have no ledger rows. Mixed protocols,
unrecognized source/digest pairs, failed/partial migration records, schema drift,
missing provenance or unreadable state stop the release before image build.
All active revisions are checked, including zero-traffic revisions reachable
through revision URLs.

Worker catalog and image provenance use one versioned gzip/base64 readback
frame, capped at 3,500 bytes. Azure action Run Command returns only the
[last 4,096 output bytes](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command#restrictions).
The decoder caps expanded JSON at 65,536 bytes and rejects malformed or
ambiguous frames. The probe error handler emits only a fixed phase label and omits raw database
errors and connection values. The transport preserves all
schema and identity checks and does not select a mode when readback fails.

**The first transition runs automatically through the maintenance release.**
The mode comes only from the positive read-only classifier; no dispatch input
can choose it or skip the check. The runtime job
retains the `azure-production` environment and global Azure deployment
concurrency group. The selected mode does not replace infrastructure readback
proof or the owned maintenance receipt.

The first transition uses the existing controlled maintenance workflow,
without a separate manual cutover flag or typed confirmation. It checks the
running worker's nonterminal scans, scan/retry queues, nonterminal webhook
tracks and legacy scheduling columns before writing a maintenance intent or
claiming admission. Busy or unreadable state aborts with writers still active.
The checks repeat after ingress closes and after writer shutdown to catch
work arriving between the read-only eligibility check and maintenance.
The workflow also checks the
actual legacy scheduling columns after every writer is stopped. If either
`nextAttemptAt` or `leaseExpiresAt` contains a value, migration stops. Complete
or resolve existing work through its normal receipt-aware path; do not clear
schedules to make the check pass. If both values are NULL everywhere, UTC
conversion preserves NULLs without a historical timezone assumption. A partial
UTC schema also stops the release; an already installed complete UTC schema
supports same-run recovery without checking the compatibility shadow columns.

The normal protected-main release starts this flow automatically when the
read-only classifier verifies the exact legacy baseline. Manual emergency
dispatch remains limited to the exact current-main SHA; it cannot force or
bypass first-transition mode.

## Release checks

PR CI verifies source and migration contracts. Protected main merges start the
release workflow directly. Azure builds and verifies the digest-pinned worker
once, then repeats the final compatibility and continuity checks before live
promotion. The exact worker image is tested on disposable PostgreSQL and Redis
without production credentials. Cloudflare releases independently, and
Lighthouse measurements run outside the deployment path.

## Implemented maintenance workflow

The protected runtime workflow implements this sequence. Reuse existing queue authority, worker environment parity, stop-provenance capture, Azure helpers and bounded deployment fixtures. Never delete queue keys, replay paid work, reverse additive schema, or infer a drained writer from an empty queue snapshot.

1. Capture immutable currently running app/scanner/worker images and previous traffic. Before claiming admission, verify that the direct migration connection addresses the same logical PostgreSQL host, decoded database name and schema (`public` by default) as both actual old-worker database connections. Different credentials and the deployed direct/pooler ports `5432`/`6432` (or default PostgreSQL port) are permitted, reflecting the existing single-backend Azure topology; unrelated ports are rejected; alias-host, database or schema mismatch fails closed with an operator configuration error. Recheck immediately before migration. Save logical identity hashes alongside full connection hashes. Before claiming admission, compare SHA-256 hashes of the actual running worker's selected `DATABASE_URL`, `DATABASE_SYSTEM_URL` and `REDIS_URL` with the old-image preflight environment. Any mismatch or unreadable identity fails closed without printing credentials. Preserve those hashes in the root-owned receipt and recheck them through shutdown and candidate promotion. Claim the existing owned scan-admission stop. Drain existing nonterminal scans normally and verify zero nonterminal scans and zero queued scan and webhook retry jobs, including paused and waiting-children states using `webhook-claims-vm.sh`'s six-state maintenance check. Failure leaves work intact and aborts maintenance. Do not stop a worker that is still executing a paid scan.
2. Block all old webhook ingress by deactivating every incompatible app/scanner revision after owned maintenance is established, including zero-traffic active revisions. Finish in-flight handlers. Disable and stop the old worker service gracefully, verify container absence and a fresh root-owned `0600` stop-provenance receipt. Check all old app/scanner revisions inactive immediately before migration. Read the durable track state and retain ambiguous historical/expired claims for receipt review. Do not clear or replay them merely to make preflight green.
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

These local fixtures do not establish a completed production transition, alert delivery, paid provider acceptance or live sustained Redis capacity. Failed maintenance retains the owned stop and disables app/scanner ingress; it never restores incompatible old writers. A same-run retry first reads the root-owned receipt and admission-stop value. An existing receipt must prove this run, immutable source, owner, nonce and database/Redis continuity before the retry can reuse maintenance mode. If no receipt and no admission stop exist, the runtime repeats the read-only classifier and proceeds only if the exact first-cutover baseline is still present. A retry of an older source is allowed only with the verified receipt. The receipt retains the original owner and nonce and audits each run attempt; a separate dispatch or different source cannot adopt it. Do not delete receipts or admission keys.

A completed receipt is terminal: rerunning only the reusable Azure job cannot reclaim maintenance or redeploy its old source. Both receipt probing and claim/recovery reject completion without modifying admission or writers; start a current-main release instead.

The lifecycle persists claim intent before Redis `SET NX`; retry repairs an absent stop only from that exact validated intent. It persists resume intent before compare-delete and completion before archiving the receipt. An uncertain resume acknowledgement is recovered by restoring the exact owned stop before withholding ingress. A compatible candidate digest and its immediately preceding compatible candidate may be retained for same-source rebuild recovery; their source, engine, protocol and database/Redis continuity must pass. Legacy images remain forensic references and are never resumed after cutover.

Azure deactivation [stops all running replicas](https://learn.microsoft.com/en-us/azure/container-apps/revisions-manage); the workflow also reads zero replicas before migration. The inactive scanner revision read-only CLI probe returned zero replicas on 2026-09-30. GitHub [reruns preserve the original SHA and ref](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), which is why same-run receipt recovery is supported without adopting a foreign source.

### Required writer inventory

The release preflight runs before image publication and must succeed; missing app or resource-group configuration fails the release. Writer inventory defaults to `app-and-scanner`, which requires both configured writer names. An intentionally scannerless ordinary deployment must explicitly set `AZURE_WEBHOOK_WRITER_TOPOLOGY=app-only` and omit the scanner name. A configured scanner cannot be excluded by this setting. The first durable-claims/2 transition still requires both writers.
