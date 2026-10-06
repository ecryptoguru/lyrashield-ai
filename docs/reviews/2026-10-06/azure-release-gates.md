# Azure release gates and CI reduction plan

## Evidence at 2026-10-06

Main `9e8a87cd72f0f8a190fb9e88aa2f40d1a809439d` passed required PR CI
run `37504282782`. Automatic release `37506738234` failed Azure baseline
classification before image build, migration, maintenance or promotion.
Cloudflare deployment succeeded. The complete live worker catalog probe returned
successfully; the previous bounded-output and PostgreSQL native-type faults no
longer blocked it.

Active writer source `3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530` is excluded by
the exact legacy profile, which accepts only
`4822306e24f375800981bf282fd992a9c15dcde8`. Their webhook protocol source,
schema, migrations and engine pin are equivalent. This does not establish the
deployed OCI digests. Public `.dockerbuild` artifact checksums are not image
manifest digests. The generic live failure does not establish that every other
legacy schema, migration and worker predicate matches.

## Gate inventory

| Stage                         | Preserve                                                                                                                   | Simplify or clarify                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Source routing                | Exact current-main dispatch and artifact source binding                                                                    | Path-scope unrelated tests; retain required check names                                                                       |
| Baseline before build         | Independently verified immutable image identity; actual writer/worker protocol; exact migration checksum and catalog state | Report fixed boolean mismatch predicates; historical single-revision tuple needs separately verified replacement evidence     |
| Build and candidate rehearsal | Digest-pinned images, product and engine labels, actual PostgreSQL/Redis smoke proof                                       | Reuse exact artifacts; do not rebuild or re-run identical assertions without a changed boundary                               |
| Runtime revalidation          | Detect changes since preflight before privileged mutation                                                                  | This second check closes a time-of-check/time-of-use gap and is not redundant with preflight                                  |
| Migration dependencies        | Source-bound manifest and archive verification before credentials are introduced                                           | Keep dependency preparation separate from privileged execution                                                                |
| Database continuity           | Exact database identity and credential continuity                                                                          | Never switch roles/passwords to satisfy a parser                                                                              |
| Maintenance admission         | Owned receipt, stopped admissions, read-only busy/drain checks, excluded old writers immediately before migration          | Business checkout/settlement acceptance is separate from technical protocol compatibility; do not fabricate business evidence |
| Migration                     | Additive forward-only schema changes and exact applied migration proof                                                     | Preserve retry and partial-migration rejection                                                                                |
| Candidate health              | Health and immutable revision/digest before traffic                                                                        | Keep readiness before promotion; public marketing checks do not establish Azure worker health                                 |
| Worker boot and promotion     | Queue drain, compatible worker before webhook ingress, systemd/image provenance proof                                      | Checks at different mutation boundaries are essential even when they invoke the same helper                                   |
| Completion/recovery           | Installed current protocol/schema check; resume only owned admission; hold ingress closed on failed maintenance            | Recovery must distinguish absent, owned and ambiguous receipts; no unchecked skip                                             |

## Finite completion plan

1. Add nonsecret predicate diagnostics without changing admission. Capture and
   assert expected mock failure output instead of emitting a false CI annotation.
2. Remove duplicate CI invocations and move informational inventory away from the
   required critical path. Path-scope unrelated suites while retaining fail-closed
   handling for unknown files and preserving required check contexts.
3. Independently review the resulting workflow and classifier diff. Validate its
   routing fixtures and all changed safety behavior once on the exact PR head.
4. Obtain existing verified deployed OCI source/engine/digest evidence and the
   baseline match inventory. A new privileged live probe or legacy trust-profile
   expansion needs explicit bounded authorization. Do not retry a deterministic
   release failure without new evidence.
5. If evidence supports an exact additional legacy profile, review that bounded
   change and prove accepted/rejected profiles plus fresh/retry migration and
   promotion lifecycle against disposable services before another release.

## CI changes in this patch

The measured preceding green run took 18m56s. Its affected-suite wall times were
core 161.20s, ops 79.04s, marketing 9.09s and motion 67.74s; marketing browser E2E
ran 119 tests in approximately 107s. These are prior-run measurements, not a
promise that every future run will save their sum.

| Before                                                                  | After                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Every shared change selected marketing and motion                       | Independent flags select the relevant project and its dependency closure; root dependency/build inputs and unknown paths still select both |
| Marketing browser tests ran for unrelated ops and workflow changes      | Marketing browser tests select marketing source and its transitive workspace dependency graph                                              |
| Ordinary app implementation selected the entire ops Node suite          | Ops selects workflows, helpers, runtime operations, package manifests/shared dependencies and unknown paths                                |
| Native catalog and queue tests ran in a dedicated step and again in ops | CI runs them once with disposable services; the default local runner retains them                                                          |
| Early webhook workflow/dispatch/Lighthouse tests repeated in ops        | Ops owns their single invocation                                                                                                           |
| Informational Knip and markdown lint were on the required path          | Their manual commands remain available; required CI omits them                                                                             |
| Push-only coverage upload/configuration in a PR-only workflow           | Unreachable branch removed                                                                                                                 |

Required check names, security audit/secret scan, RLS and money invariants,
database regression gates, engine contract and production phase rechecks remain.
The jobs still provision disposable services eagerly; separating them safely
would require a required-context aggregate and is deferred from this focused
patch. No unmeasured parallel test fanout is introduced.

## Limits of current proof

The preceding PR verified the actual complete catalog program using generated
Prisma Client and PostgreSQL 16. It also verified native Redis/BullMQ drain states
and mocked maintenance/recovery/promotion lifecycle invariants. That is not a complete live
Azure rollout, nor a single end-to-end disposable execution of every Azure CLI,
systemd and migration stage. Exact current deployed legacy OCI mappings remain
unverified. No new live DB writes, guest commands, service stops or dispatches
were issued for this plan.

## Proposed bounded read-only inventory

Repository-variable metadata identifies resource group `LyraShieldAI`, app
`lyrashield-app` and scanner `lyrashield-scanner`. The workflow defaults the
worker VM to `lyrashield-worker` when its variable is absent. Registry package
metadata alone cannot establish deployment. Its authenticated versions API also
returned HTTP 403 because the current GitHub credential lacks `read:packages`.
Do not expand credential scopes as part of this patch.

The smallest useful operational inventory has two stages:

1. Control-plane reads: list only active revisions for the two named Container
   Apps and extract their digest-pinned image references. Validate the known
   repository prefixes, 40-hex source tags and 64-hex digest strings before
   output. Inspect only OCI revision/engine labels for those exact manifests
   using already authorized registry access. Existing build records can prove
   what was published, but not what is currently deployed.
2. If no existing captured and independently verified VM probe response is
   available, run the existing read-only worker collector once against the named
   VM. It reads the running container's image/labels and existing runtime image
   reference, then executes only the five existing catalog SELECTs inside that
   container. Emit a single sanitized report with validated source/engine/digest
   identities, fixed protocol enums and the fixed baseline match booleans.
   Do not emit container environment, runtime configuration, database URLs,
   credentials, catalog expressions or raw command output.

Stage 2 is a new privileged guest command despite being read-only. It requires
explicit bounded authorization. The exact collector must be reviewed and hashed
before invocation; an ordinary release retry is not a substitute. Existing Azure
control-plane revision metadata cannot prove the OCI image running inside a VM.
Neither stage authorizes maintenance, queue writes, migration, restart, promotion
or a legacy-profile expansion.

A concrete local proposal is prepared at
`/tmp/lyrashield-webhook-inventory-proposal.mjs`, SHA-256
`6090446a5a89175a9f3eb668cb0078e0acfd16864e6458a8a26526e9c0de921a`.
It is the current verifier with one additional fixed-shape provenance report in
the existing mismatch branch. The report contains only already validated
40-hex source/engine identities, 64-hex OCI digests and fixed protocol enums.
It retains the same fail-closed classification and never writes a deployment mode
on mismatch. It has not been executed against production or published as a live
workflow. Its existing registry verification reads `ghcr-token` through the
configured Key Vault; bounded authorization must explicitly cover that in-memory
credential use without disclosure or credential changes. An isolated ephemeral
runner must own its Docker login configuration. The guest collector remains the
existing running-container inspection and five catalog SELECTs; no new guest
operation is added.
