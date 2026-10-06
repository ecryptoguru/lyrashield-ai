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
| Motion-only changes built the unrelated marketing site                  | Motion-only changes lint, typecheck and build their own desktop/portrait Vite artifact; broad builds are not duplicated                    |
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
`lyrashield-app` and scanner `lyrashield-scanner`. Read-only environment-variable
metadata confirms the `azure-production` worker VM is `lyrashield-worker`. Registry package
metadata alone cannot establish deployment. Its authenticated versions API also
returned HTTP 403 because the current GitHub credential lacks `read:packages`.
Do not expand credential scopes as part of this patch.

The smallest useful operational inventory has two stages:

1. Control-plane reads: list only active revisions for the two named Container
   Apps and extract their digest-pinned image references. Validate the known
   repository prefixes, 40-hex source tags and 64-hex digest strings before
   output. Registry inspection is blocked by the permission denial; do not use
   another identity or route to evade it. Existing build records can prove what
   was published, but not what is currently deployed.
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

The earlier combined registry/VM proposal is withdrawn following the registry
permission denial. A separate VM-only proposal is prepared at
`/tmp/lyrashield-webhook-vm-inventory-proposal.mjs`, SHA-256
`e2debc921ae9aec922dcb1ac36fd6ffed1bab6052819225271ec887b81f0d82e`.
It invokes only the existing running-container inspection and five catalog
SELECTs on `LyraShieldAI/lyrashield-worker`. It does not contact GitHub Packages,
GHCR or Key Vault and performs no Docker login, pull, credential change or grant.
It uses the established Azure management authentication to invoke Run Command;
the in-container database client uses its existing system connection internally.
No database credential is captured or emitted. A new read-only database session
is opened to the already configured endpoint. No new endpoint or identity is
introduced. Azure Run Command submits a new remote-execution request through the
existing management API and may retain its normal command/output metadata. No
persistent login, token scope expansion, role assignment or access grant is
required. The proposal does not use an alternate credential to bypass the
registry denial.

Its final report is capped at 2,048 bytes and contains `version`, fixed
`registryProvenance: UNVERIFIED`, validated worker source/engine/digest and fixed
schema/migration/protocol match booleans. The internal Azure frame remains capped
at 3,500 bytes with a 65,536-byte decoded limit; provider output is captured in
memory and raw command exceptions are suppressed. No container environment,
configuration file, URL, catalog expression or raw provider output is published.
The proposal has not been executed. It does not establish remote registry/build
provenance or authorize changing baseline admission.
