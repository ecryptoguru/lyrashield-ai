# Draft: low-rate application error notification

Status: proposal only. No alert has been created or changed by this document.

The approved policy keeps `app-any-5xx` enabled for telemetry without email actions and preserves `app-http-5xx` sustained coverage (>5 errors in five minutes), outage rules and the approved operator receiver. A low-rate regression can fall below that delivery threshold. Do not attach email actions to `app-any-5xx` or run the full provisioner as cleanup.

A separate review could consider a delayed, deduplicated low-rate signal over a longer window, with explicit recovery and suppression during known deployments. Before approval, replay historical samples to measure notification volume and compare coverage with existing sustained-error and outage rules. Define the exact resource, threshold, aggregation window, evaluation frequency, receiver binding, monthly evaluation cost and rollback plan. Preserve the intentionally disabled reconciliation/catalog rules.

Any implementation requires a new scoped plan and operator approval. Keep drafts and read-only evaluation separate from deployment or financial acceptance.
