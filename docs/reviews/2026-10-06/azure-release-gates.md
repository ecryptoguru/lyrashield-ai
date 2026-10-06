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
Prisma Client and PostgreSQL 16, native Redis/BullMQ drain states, and mocked
maintenance/recovery/promotion lifecycle invariants. That is not a complete live
Azure rollout, nor a single end-to-end disposable execution of every Azure CLI,
systemd and migration stage. Exact current deployed legacy OCI mappings remain
unverified. No new live DB writes, guest commands, service stops or dispatches
were issued for this plan.
