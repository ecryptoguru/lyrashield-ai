# Retained-worker release qualification hold

`release-retained-worker.yml` remains held before checkout, qualification-record
reads, image publication or deployment. Both jobs in `deploy-azure-runtime.yml`
also retain unconditional production holds, including `retained_worker: true`.
An operator record or successful readiness probe cannot remove these holds.

The retained record binds an exact candidate to the observed worker, engine,
sandbox, relay and environment identities. It has no authenticated qualification
proof. The observed worker is product `b03f0bbe2b42f3a49e24e103655187372ba0a5f6`
with engine `3001517530300ca5f602536bfadcbd3c95ad3039`; it lacks current delegated
fix-generation authority/deletion checks and current gate retest-evidence checks.
Its healthy readback does not qualify those behaviors, the protected sandbox,
or isolated runtime authority. Historical gate verdicts also require current
receipt-backed assessment before new assurance issuance.

The existing signed `lyrashield-qualified-fleet/2` consumer requires the complete
broker, supervisor, gateway, runtime-policy and migration digest binding and
rejects that retained engine. Signed held-baseline records remain rollback-only
and cannot authorize admission. The retained route does not compose a successful
qualification verifier or physical-action authority with its operator record.
There is no qualified retained tuple that can lift this hold today.

The source, immutable image, runtime readback, schema/privilege, billing, migration,
queue and health/rollback checks remain behind the hold for future integration.
Before activation, the release entrypoints must consume authenticated immutable
qualification for the exact candidate and complete runtime tuple, including
current worker protections, sandbox and isolated authority. They must revalidate
that qualification at deployment mutations and admission release. Adding or
changing `LYRASHIELD_RETAINED_WORKER_APPROVAL` alone is insufficient.

No worker/relay replacement, admission release, live restore, deployment or
production qualification is established by this held preparation route.
