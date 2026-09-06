# AI pipeline remediation — 6 September 2026

This release preserves Luna/Terra routing and existing protected budgets while correcting usage accounting, scanner deadlines, deterministic retest dispatch, and Desktop spending controls.

## Compatibility and deployment

Merge the matching engine PR first and wait for its required checks. Pin both worker and Desktop workflows to that merged engine revision. Then merge the application PR after its own CI, cross-repository contract, and security review pass. Production promotion must reconcile exact image digests and health; local tests alone do not prove release completion.

Triage retains its existing schema and adds private `llmUsage.accountingComplete`. A false value means some started requests have no final usage receipt. Preserve the known tokens but leave the total unreconciled. Never treat a missing receipt as zero spend. Partial checkpoints contain no usable triage judgments.

Deterministic repository retests use persisted finding lineage and complete baseline scanner receipts. They run the deterministic repository suite with a separately established source revision and a versioned private source execution receipt. They do not invoke the AI engine or optional AI triage. Unsupported source material or missing lineage remains an explicit failure/inconclusive outcome. Ordinary AI findings continue through the normal source-tier scan.

The normalizer's score describes evidence completeness, not calibrated accuracy or verification. Only separate evidence verification can establish a verified finding. Desktop budgets belong to the customer's BYOK account and use the installed engine's routing and rate configuration; those estimates are not a provider invoice guarantee.

## Verification and boundaries

Offline regression coverage includes malformed and interrupted triage, dedupe output caps and invalid identities, SDK retry ownership, deadline reconstruction, scanner timeout preservation, retest authority/source isolation, and Desktop budget validation. Run the full engine pytest suite, application core Vitest suite, worker type/lint checks, and Desktop Rust/frontend checks before release.

No evaluation corpus or paid paired comparisons are included: the user explicitly excluded that work. Existing historical costs and synthetic scenarios remain distinct. There are no current-revision production performance or recall claims. Independently reconciling every scan with an Azure invoice requires retained provider correlation absent from older receipts; shared-resource meter totals must not be divided by application scan count.

Rollback uses the prior digest and matching engine pin. Restore prior code through an ordinary reviewed release; do not reverse database migrations, weaken budgets, relabel unknown usage as zero, or convert missing coverage into a passing retest.
