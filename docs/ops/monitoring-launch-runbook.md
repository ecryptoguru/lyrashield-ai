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
group. Set `LYRASHIELD_OPERATOR_EMAIL` to the currently assigned primary operator when
provisioning. Receiver rotation requires re-running provisioning and a test alert.

## Rules

| Rule                                                 | Fires when                                                                         | Severity |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| `scan-readiness-unavailable`                         | Scan readiness has failed for more than 5 minutes                                  | 1        |
| `scan-queue-depth-high`                              | Queue depth exceeds twice configured worker concurrency for 10 minutes             | 2        |
| `scan-queue-oldest-wait-high`                        | Oldest waiting job exceeds 5 minutes                                               | 2        |
| `reconciliation-drift`                               | Queue reconciliation repairs queue/database drift                                  | 1        |
| `webhook-dead-letter`                                | At least one required webhook track is dead-lettered                               | 1        |
| `evidence-persistence-failure`                       | A recent terminal scan records an evidence-storage failure                         | 1        |
| `terminal-cost-unreconciled`                         | A terminal provider-backed scan remains cost-unreconciled for more than 15 minutes | 1        |
| `worker-vm-unavailable`                              | Azure VM availability is below 1 for 5 minutes                                     | 1        |
| `worker-cpu-high`                                    | Worker VM CPU is above 85% for 15 minutes                                          | 2        |
| `app-no-active-replica`, `scanner-no-active-replica` | Active replica count is below 1 for 5 minutes                                      | 1        |
| `app-replica-restart`, `scanner-replica-restart`     | Azure reports a replica restart                                                    | 2        |

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

## Provision and verify

Run from a reviewed checkout with an authenticated Azure CLI identity allowed to
manage Monitor resources. Set:

- `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, and `AZURE_LOCATION`;
- `LOG_ANALYTICS_WORKSPACE_ID`, its query GUID in
  `LOG_ANALYTICS_WORKSPACE_GUID`, and the associated `WORKER_DCR_ID` that collects
  Syslog into that workspace;
- `WORKER_VM_NAME` and `WORKER_VM_RESOURCE_ID`;
- `APP_RESOURCE_ID` and `SCANNER_RESOURCE_ID`;
- `LYRASHIELD_OPERATOR_EMAIL`.

Then run:

```sh
sh ops/monitoring/provision-alerts.sh
```

The script is idempotent. Retain readback output from `az monitor metrics alert list`,
`az monitor scheduled-query list`, and `az monitor action-group show` with release
evidence. Confirm every enabled rule references the exact
`lyrashield-operator-alerts` action-group resource ID. Send one Azure test notification
and retain the named acknowledgment before enabling paid admission.

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
