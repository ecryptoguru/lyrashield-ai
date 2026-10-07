# Supabase database CA trust correction

Recovery run `37635622656` failed app readiness with 23 database certificate-chain errors. Retained application logs were queried using only closed classifications; the result was `SELF_SIGNED_CHAIN`. Successful failure cleanup retained the original admission hold and deactivated app/scanner writers. The new worker was never booted.

## Public certificate provenance

The operator supplied `prod-ca-2021.crt` from the production Supabase dashboard's Database Settings > SSL configuration for project `yejmvtgsxniatmjbwplk` on 2026-10-07. [Supabase's guidance](https://supabase.com/docs/guides/platform/ssl-enforcement) requires the dashboard CA for verified database TLS.

- Subject and issuer: `C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA`.
- DER SHA-256: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.
- Validity: 2021-04-28 10:56:53 UTC through 2031-04-26 10:56:53 UTC.
- Constraints: critical `CA:TRUE`; certificate-signing and CRL-signing usage.
- Offline self-signature and certificate verification passed. This certificate contains no private key.

## Exact proposed production change

Ship the pinned public root in `@lyrashield/db`. Only an already validated canonical Supabase database connection receives it in its `pg` TLS `ca` option. Append it to `tls.getCACertificates("default")` so configured Node defaults and process-start extra roots remain available. Keep `rejectUnauthorized: true` and Node's default hostname verification. Both runtime and system Prisma pools use this shared connection configuration.

Ordinary database targets retain their existing connection configuration. The proposal does not alter the host/global TLS trust store, Supabase SSL enforcement, connection URLs, passwords, roles, receipt hashes, migration state or admission ownership. Certificate rotation requires another reviewed source change.

## Verification and remaining release gates

The focused connection/pool suites passed 48 tests. The disposable Docker/PostgreSQL TLS suite passed 40 cases using the cached worker with explicit local source overlays, including wrong CA, wrong hostname, runtime/system pools, raw URL SHA continuity and restricted-role assertions. This is local regression evidence, not exact new production image evidence.

Before rollout: require independent source review and required CI on the exact patch; approve this scoped production trust addition; merge and build new exact-source candidate images; verify the prepared receipt's source/engine/digests/harness binding; run the exact-image rehearsal. Then use the original held recovery path with run `37516632066`, source `af2b7a5acf34cf23a6577181de92e8d010f0beb2` and immutable owner `37516632066:1`.

Live database trust and role acceptance remain unverified. Recovery must stop on certificate, hostname, role, receipt, image, readiness or admission mismatch. Only successful full readiness and provenance proof may release the exact original hold token. This patch alone does not establish production readiness.
