# Production monitoring launch runbook

This runbook covers paid scan admission, worker/queue health, evidence persistence,
cost reconciliation, and Azure runtime capacity. Alerting is bounded operational
evidence, not proof of universal availability or security.

## Ownership and acknowledgment

`lyrashield-operator-alerts` is the only action group for these rules. The **Primary
Production Operator** owns first response and must acknowledge the alert within five
minutes using their named incident identity. Record the alert rule, UTC firing time,
app revision, worker image digest, acknowledgment identity/time, and admission state.
If no acknowledgment exists after five minutes, the **Founder Escalation Owner** takes
incident command.

Do not put a shared mailbox, anonymous identity, or unowned webhook in the action
group. Set `LYRASHIELD_PRIMARY_OPERATOR_EMAIL` and
`LYRASHIELD_FOUNDER_ESCALATION_EMAIL` to the two named operators. Provisioning fails
unless the action group contains exactly those two enabled common-schema email
receivers. Receiver rotation requires re-running provisioning and a test alert.

## Rules

Every rule below routes to the single `lyrashield-operator-alerts` action group
(Primary Production Operator), auto-mitigates when the firing condition clears
(`autoMitigate=true`), and is read back after provisioning (`enabled`, action-group
binding, auto-mitigation) before provisioning is considered successful.

| Rule                                                 | Signal source                                 | Fires when (threshold / window)                            | Severity | Auto-resolution               | Readback             |
| ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- | -------- | ----------------------------- | -------------------- |
| `scan-readiness-unavailable`                         | App log `Scan service readiness check failed` | Readiness failed more than 5 minutes (10m window, 5m eval) | 1        | Readiness returns 200         | Scheduled-query show |
| `scan-queue-depth-high`                              | Worker `operator_alert` code                  | Queue depth > 2× concurrency for 10 minutes                | 2        | Depth returns below threshold | Scheduled-query show |
| `scan-queue-oldest-wait-high`                        | Worker `operator_alert` code                  | Oldest waiting job > 5 minutes                             | 2        | Queue drains below threshold  | Scheduled-query show |
| `reconciliation-drift`                               | Worker `operator_alert` code                  | Queue/database drift repaired                              | 1        | No drift on next cycle        | Scheduled-query show |
| `webhook-dead-letter`                                | Worker `operator_alert` code                  | At least one required webhook track dead-lettered          | 1        | Track retried to success      | Scheduled-query show |
| `evidence-persistence-failure`                       | Worker `operator_alert` code                  | Recent terminal scan records an evidence-storage failure   | 1        | No new failures in window     | Scheduled-query show |
| `terminal-cost-unreconciled`                         | Worker `operator_alert` code                  | Terminal provider-backed scan unreconciled > 15 minutes    | 1        | Cost reconciled               | Scheduled-query show |
| `worker-vm-unavailable`                              | Azure `VmAvailabilityMetric`                  | Availability below 1 for 5 minutes                         | 1        | VM available again            | Metrics-alert show   |
| `worker-cpu-high`                                    | Azure `Percentage CPU`                        | CPU above 85% for 15 minutes                               | 2        | CPU returns below 85%         | Metrics-alert show   |
| `app-no-active-replica`, `scanner-no-active-replica` | Azure `Replicas`                              | Active replica count below 1 for 5 minutes                 | 1        | Replica count ≥ 1             | Metrics-alert show   |
| `app-replica-restart`, `scanner-replica-restart`     | Azure `RestartCount`                          | Azure reports a replica restart                            | 2        | No restart in window          | Metrics-alert show   |

Application rules consume redacted structured `operator_alert` records. Azure metric
rules use documented `VmAvailabilityMetric`, `Percentage CPU`, `Replicas`, and
`RestartCount` signals. `provision-alerts.sh` refuses to create rules unless the worker
VM has a healthy Azure Monitor Agent, the exact data collection rule association, a
Syslog source routed to the configured workspace, an actual `LyraShield worker
starting` application log within the last 24 hours, and a `ContainerAppConsoleLogs_CL`
row for the exact production app resource within the last 24 hours. A configured DCR
without both live readbacks fails closed before any action group or alert mutation.

Individual expired leases are **INCONCLUSIVE** because the current worker registry
prunes expired members during heartbeat refresh. Loss of every live lease is covered by
`scan-readiness-unavailable`; no separate expired-lease rule is provisioned until a
durable lease-expiry counter exists.

A scheduled egress pin change may defer its restart while the single-concurrency worker
has an active scan. The current refresh script preserves readiness and the validated
old/new firewall union for that known-active case, then retries the token-bound drain
when idle. A claim that races after preflight can still make scan readiness fail closed
while the job drains. Acknowledge that transition; distinguish it from a crash using the
pin-change, drain, active-scan, and terminal-cost logs; never suppress it blindly. Close
the alert only after the in-flight scan reaches a non-replayed terminal state and the
same product, engine, worker-image identities, healthy container, queue reconciliation,
cost reconciliation, and readiness `200` are read back.

Provider (Polar/Razorpay) readiness is **INCONCLUSIVE**: current logs are
request-scoped prose that can include provider/catalog context, so there is no stable,
secret-free global readiness-transition signal to alert on. A provider-readiness rule
will be added only when the worker or web app emits a structured, redacted
`operator_alert`-style transition event; do not grep arbitrary prose or log provider
payloads.

Ownership: the **Primary Production Operator** acknowledges every firing rule within
five minutes using their named incident identity and records the rule, UTC time, app
revision, worker image digest, acknowledgment, and admission state. Without
acknowledgment within five minutes, the **Founder Escalation Owner** takes incident
command. Stop scan admission before any investigation that could leave readiness,
queue state, evidence persistence, or cost accounting uncertain.

## Provision and verify

Run from a reviewed checkout with an authenticated Azure CLI identity allowed to
manage Monitor resources. Set:

- `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, and `AZURE_LOCATION`;
- `LOG_ANALYTICS_WORKSPACE_ID`, its query GUID in
  `LOG_ANALYTICS_WORKSPACE_GUID`, and the associated `WORKER_DCR_ID` that collects
  Syslog into that workspace;
- `WORKER_VM_NAME` and `WORKER_VM_RESOURCE_ID`;
- `APP_RESOURCE_ID` and `SCANNER_RESOURCE_ID`;
- `LYRASHIELD_PRIMARY_OPERATOR_EMAIL` and
  `LYRASHIELD_FOUNDER_ESCALATION_EMAIL`.

Then run:

```sh
sh ops/monitoring/provision-alerts.sh
```

The script is idempotent and performs its own readback: after create/update it runs
`az monitor metrics alert show` and `az monitor scheduled-query show` for every rule and
fails unless each is enabled, auto-mitigates, and is bound to the exact
`lyrashield-operator-alerts` action-group resource ID. Retain the script's readback
output (plus `az monitor metrics alert list`, `az monitor scheduled-query list`, and
`az monitor action-group show`) with release evidence. Send one Azure test notification
and retain the named acknowledgment before enabling paid admission.

## Terminal-cost disposition

Do not clear `terminal-cost-unreconciled` from missing application logs. For a
historical scan, retain a JSON evidence file from the exact Azure OpenAI account whose
`AzureOpenAIRequests` total is zero for a window covering the stored scan start and end
(with no more than five minutes of buffer per side). Zero provider requests is the
basis for zero provider cost. Bind the evidence SHA-256, exact Cognitive Services
account resource ID, UTC window, and query timestamp into the reviewed receipt.

Set `TERMINAL_COST_AZURE_RESOURCE_ID` to that exact account resource ID and run
`pnpm --filter @lyrashield/worker review:terminal-cost-disposition` without `--apply`
first. Apply only after the receipt, evidence-file digests, unchanged database state,
and an approved verified MFA-enabled platform operator all pass preflight. The command
is limited to the two known historical scan IDs, appends idempotent scan/audit receipts,
and never invents usage or edits money columns.

## Redis and egress candidate gate

Before staging the worker Redis/egress candidate, retain a live Redis command-metric
baseline. The 30-day idle estimate of 324,019 commands before and 132,495 after (a
59.11% reduction) is a model only; it is not telemetry or production proof. Stage the
worker image first, verify CISA KEV enrichment uses the authenticated proxy and the
negative egress tests still pass, then deploy the host refresh script that removes the
direct CISA pin. Do not delete BullMQ keys, replay ambiguous work, or claim rollout
success until the staged runtime evidence and command metrics are retained.

## Stop admission

Stop new scans immediately when readiness, lease authority, queue state, evidence
persistence, or provider-cost accounting is uncertain:

```sh
REDIS_URL='rediss://…' sh ops/monitoring/scan-admission.sh stop OPERATOR INCIDENT_REASON
REDIS_URL='rediss://…' sh ops/monitoring/scan-admission.sh status
```

The shared queue authority rejects new scans, retests, and scheduled scans while the
Redis stop key exists. Existing work is not cancelled or replayed. Preserve the stop
record, inspect active paid work, and use the authenticated cancellation flow only when
the incident decision requires it. Never delete BullMQ jobs or keys.

Resume only after readiness, queue/database reconciliation, evidence retrieval, and
cost state are known:

```sh
REDIS_URL='rediss://…' sh ops/monitoring/scan-admission.sh resume OPERATOR
REDIS_URL='rediss://…' sh ops/monitoring/scan-admission.sh status
```

Record the resuming identity/time and the evidence that closed every firing condition.

## Release validation

Run local regression checks first:

```sh
pnpm exec vitest run packages/integrations/src/queue.test.ts apps/worker/src/operational-health.test.ts
sh ops/monitoring/scan-admission.test.sh
sh ops/monitoring/provision-alerts.test.sh
shellcheck ops/monitoring/*.sh
git diff --check
```

In production, inject one controlled signal per rule family. Confirm the expected rule
fires, reaches the action group, receives a named acknowledgment, and resolves. During
the admission drill, verify scan and retest creation return service-unavailable without
creating or replaying paid work, then verify normal creation after resume.

Azure signal references:

- [Azure Container Apps metrics](https://learn.microsoft.com/azure/container-apps/metrics)
- [Azure VM availability monitoring](https://learn.microsoft.com/azure/virtual-machines/flash-azure-monitor)
- [Azure CLI scheduled query rules](https://learn.microsoft.com/cli/azure/monitor/scheduled-query)
