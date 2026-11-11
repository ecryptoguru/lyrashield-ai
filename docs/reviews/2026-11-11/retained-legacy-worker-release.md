# Web and scanner release with the retained legacy worker

`release-retained-worker.yml` releases the exact current merged product source to
web and scanner while retaining the existing worker, engine, sandbox and relay.
It does not activate the new runtime control plane. The automatic production,
new-worker, marketing and recovery qualification holds remain separate.

The route uses the existing required PR check/source receipt qualification,
current-main checks, durable webhook writer verification, v26 schema and writer
capability checks, exact image checks, source-bound migration dependencies,
forward-only migrations, billing-admission preservation, zero-traffic candidate
smoke, traffic health checks and traffic rollback. The protected review record
must match the exact candidate; a later main merge requires a fresh review of
its producer payload, execution-plan/budget interpretation, migrations and
legacy consumer behavior. Readiness alone does not establish compatibility.

The `azure-production` variable `LYRASHIELD_RETAINED_WORKER_APPROVAL` contains this
strict JSON record. Replace both candidate fields with the exact reviewed merged
SHA after its required checks pass. Do not populate the record from readiness
alone or silently advance it with main. Updating this record and dispatching the
already-authorized release does not require an additional confirmation phrase.

```json
{
  "schema": "lyrashield-retained-worker/1",
  "sourceSha": "EXACT_REVIEWED_MERGED_PRODUCT_SHA",
  "reviewedSourceSha": "EXACT_REVIEWED_MERGED_PRODUCT_SHA",
  "workerSourceSha": "b03f0bbe2b42f3a49e24e103655187372ba0a5f6",
  "workerDigest": "sha256:9e942d0564e849d9c453b301bd5a88b1a35d8b326ba7791149bdf95048f96ad3",
  "engineRevision": "3001517530300ca5f602536bfadcbd3c95ad3039",
  "sandboxImage": "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:73067cefe2138c89c1f63abb597f006f66eae22dca332a6b01398d870a638dcf",
  "workerEnvironmentSha256": "91297b19ab26077a30b968611b1b53fca114dfee22f93135a509dcb095e1d6d8",
  "egressSourceSha": "b03f0bbe2b42f3a49e24e103655187372ba0a5f6",
  "egressDigest": "sha256:272b72d1c81f87d94348caed86bda0dd5ba0c80500252ba9f0989080b786de4c"
}
```

These baseline identities were independently read at 2026-11-11T17:48:35Z.
The worker service was active and the container healthy; runtime identities and
OCI labels matched. `assertScanWorkerAvailable` passed, the database had zero
nonterminal scans, and scan/webhook queues had zero wait, active, delayed,
prioritized, paused and waiting-child jobs. The relay had a sole 100% healthy
revision. These are dated baseline observations. Every release repeats live
readbacks before runtime mutations, before traffic promotion and after promotion.

The worker environment hash is SHA-256 of `JSON.stringify([...Config.Env].sort())`
from the running container. The readback compares it privately without printing
credentials. The queue/heartbeat probe executes inside the existing worker; it
does not refresh secrets, create a worker container, restart services or change
admission. The existing v26/webhook read-only collectors can use temporary guest
probe files. Worker vault writes and relay mutations are excluded from this route.
A drifted identity, environment, Redis endpoint, unresolved work, unhealthy relay,
held admission, unavailable readback or maintenance schema fails the release.

Dispatch `release-retained-worker.yml` from `main` with `source_sha` set to the
reviewed merged SHA. It builds only the immutable web image. The image verifier
checks the new web source and retained worker source separately while retaining
engine, accounting protocol and compiled runtime capability checks. No worker or
relay image is built or promoted, and no admission-stop release occurs.

This route delivers web/scanner changes only. It does not deliver worker changes
since `b03f0bb`, including new worker claim/lifecycle/cancellation/attachment
behavior, the `079194b` engine, or isolated broker/supervisor/gateway dispatch.
New-engine URL/API relay capabilities remain unavailable. Features that require
those changes must remain unavailable or block the exact candidate review.
Paid scan, billing, positive fix/retest, device and financial acceptance are not
established by a successful readiness probe or this release route.
