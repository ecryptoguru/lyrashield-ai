# PHP detection and remediation

This runbook describes source capabilities. Deployment and customer acceptance
require separate evidence. Repository scanners do not execute the customer's PHP
code or send PHP2Shell exploit or load probes.

## Project selection and coverage

Standard and Deep repository scans detect PHP project scopes before adding
PHP-specific analyzers or optional post-scan engine triage context. A non-PHP
repository keeps its ordinary repository checks without those PHP additions. Initial engine
instructions are unchanged; PHP context is limited to existing eligible
AI-security triage excerpts, within their 4,096-byte bound, with no additional
engine calls. This context is limited to the existing enabled, accounted
Standard/Deep medium-severity AI-security candidate cohort. Discovery uses
repository source and declarations; it does not execute PHP or Composer to identify a
project. Documentation, tests, fixtures and example paths are excluded
from PHP application source selection; `.php` extension matching is
case-insensitive. Excluded examples do not establish a PHP application scope.

In a monorepo, review each PHP service and its associated manifest, lockfile and
runtime declarations. A runtime declaration for one service must not be treated
as inventory for every sibling service. Child service boundaries also prevent
inheriting a root runtime declaration. Discovery receipts are capped at 32 PHP
scopes and 64 service boundaries; overflow suppresses PHP triage context and stays
incomplete. Discovery limits, unreadable inputs and
PHP scopes without usable exact runtime identity remain incomplete; absence of
a runtime CVE finding does not make those services clean. Composer resolver
constraints establish dependency resolution context, not the PHP version serving
requests.

## Detection scope

| Input                                    | Deterministic family | Meaning and limits                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composer.json` and `composer.lock`      | SCA                  | Exact stable production, development and transitive Packagist releases. A matching Composer content hash is required for complete inventory. Missing, stale, malformed, unreadable or bounded input remains incomplete. PHP and extension constraints are platform declarations, not Packagist packages. |
| Dockerfile and Compose PHP images        | IaC                  | Exact recognized official PHP tags are declarations. Variables, floating tags, custom images, unsupported suffixes and digest-only identities require independent inventory. A tag plus digest is still a declaration, not a registry or deployed-image check.                                           |
| Composer `config.platform.php`           | IaC                  | An exact resolver platform declaration. Neither `require.php` nor `config.platform.php` proves the installed web runtime.                                                                                                                                                                                |
| `project.toml` buildpack environment     | IaC                  | Parsed CNB schema 0.2 and legacy 0.1 `BP_PHP_VERSION` declarations. One exact stable value is source evidence only; duplicate/mixed schemas, unsupported buildpacks and explicit overrides remain incomplete.                                                                                            |
| `.php-version`                           | IaC                  | One exact stable version line, with an optional final newline. Ranges, comments, multiple values and malformed input remain incomplete; no automatic edit is generated.                                                                                                                                  |
| `php-runtime.json`                       | IaC                  | Strict, bounded, user-reported supporting inventory. Backport claims never suppress upstream advisory candidates.                                                                                                                                                                                        |
| `php.ini`                                | IaC                  | Conservative declaration warnings for enabled `display_errors` and `allow_url_include`; effective deployment configuration remains unknown.                                                                                                                                                              |
| Public `Server` / `X-Powered-By` headers | URL                  | Passive version-disclosure lead from an existing response. No CVE is inferred from a header.                                                                                                                                                                                                             |
| PHP `.php` application source            | SAST                 | Bounded request/local-variable flow to command, SQL, deserialization, inclusion/path, upload, XML entity and outbound URL sinks. Cross-file, function-return, authorization, CSRF and session analysis remain incomplete.                                                                                |

Buildpack declarations use the current
[`[[io.buildpacks.build.env]]` schema 0.2](https://buildpacks.io/docs/reference/config/project-descriptor/)
or the [legacy `[[build.env]]` schema](https://github.com/buildpacks/spec/blob/extensions/project-descriptor/v0.1/extensions/project-descriptor.md).
[Paketo documents `BP_PHP_VERSION` precedence](https://paketo.io/docs/howto/php/#install-a-specific-php-version)
over Composer declarations, and build-time flags can override descriptor values.
The scanner assesses source declarations independently and does not infer the effective
installed runtime or builder support. Parsing is capped at 64 KiB and 256 environment
entries. Explicit buildpack groups are limited to `paketo-buildpacks/php` and
`paketo-buildpacks/php-dist`; unsupported groups or overrides require independent
inventory. A known PHP group without an exact version stays partial. Both new inputs
remain unverified, carry override uncertainty and produce no automatic runtime edit.

The pinned runtime catalog is `php-maintainers-2026-10-23.1`: 29 maintainer
advisories published in 2026 and three selected older PHP KEV advisories
(CVE-2024-4577, CVE-2019-11043 and CVE-2012-1823). Matching uses each advisory's
exact branch and lower/upper bounds. It does not compare an 8.2 release against
an 8.5 fix threshold. SAPI, extension and OS conditions remain explicit; omitted
conditions are unknown. The catalog is reviewed source data, not a continuously
updated feed or an exhaustive historical PHP catalog. Update its primary-source
ranges and boundary tests together when PHP publishes another advisory or ends
branch support. See the [catalog](../packages/security/src/php-runtime-advisories.json)
and [catalog tests](../apps/worker/src/engine/scanners/php-runtime-catalog.test.ts).

Declared end-of-life branches receive an upgrade warning. Future branches outside
the pinned catalog remain unknown rather than being assumed end-of-life or clean.
Vendor backports need vendor evidence; a low upstream version alone cannot settle
whether the installed vendor package contains a fix.

Source rules are pinned at `php-source-local-flow/1.0.1`. They recognize a bounded
subset of request helpers, local assignments, interpolation, parameterized SQL,
sink-specific shell/integer sanitizers and fixed literal allowlist lookups.
Receiver types and branch reachability are not established. Unsupported syntax
and reached token/statement/nesting limits are explicit coverage issues. Every
scanned `.php` file keeps partial SAST coverage because this local analysis cannot establish
cross-file or application-wide absence. It emits review guidance and source
provenance, with no automatic source patch or exploit-validation claim. The
deterministic integration selects `.php` files case-insensitively; alternative PHP template/include
extensions require separate review and are not covered by this source benchmark.

## Browser-local PHP2Shell review

The free [PHP2Shell checker](https://lyrashieldai.com/tools/php2shell-checker)
guides a review of a reported PHP version and deployment conditions. Its version
assessment shares the browser-safe `@lyrashield/security/php-security` advisory
matcher with the worker. The original advisories are CVE-2026-109618 and
CVE-2026-109619; compare exact versions within their own branch. The checker
makes no target requests, uploads no inputs and runs no exploit or load test.
Unknown versions and deployment details remain unknown, and a result is not an
installed-runtime attestation, a finding verification or a compromise assessment.

**Separate notice, reviewed 24 October 2026:** PHP's
[23 October session upload progress notice](https://www.php.net/archive/2026.php)
describes CVE-2026-115560, with a full advisory and fix expected in a later regular
release. It supplies no fixed-version threshold to reuse from the original pair.
The condition review requires upload progress to be enabled, a configured
`php_binary` or `php_serialize` session handler and an application switch to `php`
with `ini_set()` before `session_start()`. PHP recommends disabling
`session.upload_progress.enabled` pending the regular fix; applications that
never switch handlers at runtime may retain the feature. Check effective serving
configuration independently and retain unknown answers as unresolved.

A version past the original two advisory thresholds does not resolve this
separate notice. A Composer dependency update does not replace PHP. Apply runtime
remediation through the deployment process below and preserve readback from the
serving workers rather than relying on a source declaration or public banner.

## Supporting runtime inventory

Place one `php-runtime.json` alongside the corresponding service source. The
scanner accepts at most 64 KiB and rejects unknown fields, duplicate JSON keys,
non-exact versions and duplicate extension names. Optional fields can be omitted
when unknown. This illustrative example is not a deployment receipt:

```json
{
  "schemaVersion": 1,
  "version": "8.4.26",
  "sapi": "fpm",
  "extensions": ["openssl", "soap", "pgsql"],
  "os": "linux",
  "vendorPackage": "php8.4-fpm-8.4.26-vendor1",
  "backports": ["CVE-2026-109618"],
  "replicas": 2
}
```

- `version`: required stable `major.minor.patch`, with no range, prerelease or
  vendor suffix. Keep the vendor revision in `vendorPackage`.
- `sapi`: `cli`, `fpm`, `cgi`, `apache2handler`, `frankenphp` or `litespeed`.
- `extensions`: at most 128 unique lowercase names containing letters, digits
  and underscores, each at most 64 characters. Omission means unknown.
- `os`: `linux`, `windows` or `other`.
- `image` and `vendorPackage`: optional nonempty strings, at most 256 characters.
  Preserve the actual image digest in `image` when available. The scanner does
  not resolve it against a registry.
- `backports`: at most 64 CVE/GHSA identifiers. These are reported claims and
  trigger an independent-verification coverage issue.
- `replicas`: integer 1–100000. This reports context; it does not count active
  replicas or prove that all of them were replaced.

Collect evidence through owner-authorized administrative access for each serving
runtime. Record the time, service, environment, package version and vendor
revision, actual image digest, SAPI, extensions and effective configuration. CLI
PHP can differ from FPM, Apache or another web SAPI on the same host. Do not use
CLI output as proof of the web worker's identity. Never expose a public `phpinfo`
endpoint to collect evidence.

Keep the original image/package SBOM, vendor backport advisory, deployment and
worker replacement records alongside the normalized inventory. Existing
authenticated scan attachments can retain supporting files under their current
checksum and staging contract. Raw CycloneDX/SPDX files and attachments are not
automatically converted into trusted PHP attestations or deterministic runtime
inventory. The deterministic matcher consumes the strict repository inventory
above; authenticated upload establishes who submitted bytes, not their truth.
Do not commit credentials, environment dumps or sensitive host identifiers.

## Composer fix proposals

The dedicated Composer producer requires a promoted deterministic SCA candidate,
its original completed checksummed scan manifest, the exact scanned commit and
an active workspace GitHub integration. It reads the manifest and lock from that
commit. Model claims or client-supplied patches cannot authorize a lock update.

Official Packagist metadata travels through the existing authenticated egress
proxy in production. The resolver image is pinned by digest. Its container has
no network, a read-only root, bounded resources and a private temporary directory.
It runs only worker-owned code; Composer scripts, plugins and installation are
disabled. The original manifest is restored before lock validation and a dry-run
install consistency check. Target application tests are not executed in this
resolver.

The first supported update changes one exact stable package while preserving
the dependency set, unrelated package records and manifest semantics. Custom or
private repositories, stale locks, incompatible constraints/platforms and updates
requiring new or wider dependency changes receive an actionable unavailable
result. A transient infrastructure failure retries; an exhausted attempt settles
the draft as failed. Request a new proposal after correcting the cause.

The sealed artifact binds workspace, target, finding, proposal, commit, exact
before/after lock bytes, diff, resolver identity and consistency checks. Approval
and execution revalidate these bindings and the existing plan scope/line ceilings.
Generic structured patches still reject lockfiles. Large lock rewrites can exceed
the normal scope ceiling and require a manual reviewed update.

**Application compatibility stays unverified.** The proposal summary and approval
identify the action as opening a draft PR for customer CI and review. Composer
PRs are forced to draft; there is no automatic merge. Run the customer's normal
unit, integration and security regression tests against the exact PR commit,
review any runtime/platform constraints and mark the PR ready only after those
checks pass. Composer consistency does not substitute for application tests.

## Runtime fixes and retests

Recognized mutable official Dockerfile tags can receive a structured, full-file
edit to the latest fixed release retained for their current supported branch.
The existing suffix and Dockerfile content are preserved. Automatic edits are
limited to 16,000 characters and 256 lines before the existing diff builder runs;
larger files retain findings and manual remediation guidance. No digest is invented,
removed or changed. Digest-pinned images, vendor packages, managed hosts,
appliances, Compose/platform declarations and end-of-life branch migrations need
operator or vendor action and compatibility testing.

For a runtime remediation:

1. Review the primary PHP or vendor advisory and choose the fixed package/image.
   Verify the immutable artifact and relevant SAPI/extensions/configuration.
2. Build and test the application on that runtime. Rebuild stale base images and
   deploy the approved immutable artifact through the customer's release process.
3. Replace/restart every serving worker and replica. Account for old deployments,
   background workers, scheduled jobs and appliances that embed PHP. Retain the
   rollout and termination evidence for the old workers.
4. Independently read back the actual runtime/package and image identity from
   every active serving replica. Compare vendor backports against the relevant
   advisory. Preserve original evidence and the source revision together.
5. Run a new authorized scan/retest and assess the source and runtime evidence
   separately. A clean source retest of any `php_runtime_` finding remains
   `INCONCLUSIVE`: this implementation has no trusted deployed-runtime verifier
   and cannot automatically set that finding `FIXED`/`VALIDATED`.

Composer/source retests retain the existing complete deterministic manifest and
coverage requirements. Partial PHP SAST coverage therefore cannot produce a
validated clean source claim. Runtime declarations, banners, replica counts, uploaded
assertions and model confidence never establish independent verification.
Patching a runtime also does not remove prior compromise; incident investigation
and credential recovery require their own evidence.

## Local verification

Run runtime, inventory and fix tests from the repository root:

```sh
pnpm exec vitest run packages/security/src/php-security.test.ts apps/worker/src/engine/scanners/php-project-integration.test.ts apps/worker/src/engine/scanners/php-runtime.test.ts apps/worker/src/engine/scanners/php-runtime-catalog.test.ts apps/worker/src/engine/scanners/resolved-dependencies.test.ts apps/worker/src/engine/scanners/composer-dependencies.test.ts apps/worker/src/engine/scanners/sca-scanner.test.ts
LYRASHIELD_COMPOSER_SMOKE=1 pnpm exec vitest run apps/worker/src/jobs/composer-fix.test.ts
pnpm exec vitest run packages/fix/src apps/worker/src/jobs/composer-fix-proposal.test.ts apps/worker/src/jobs/fix-generate.job.test.ts apps/web/src/lib/composer-fix-pr.test.ts apps/worker/src/engine/result-integrity.test.ts
pnpm exec vitest run apps/worker/src/engine/scanners/php-source-benchmark.test.ts --reporter=verbose
```

The Docker smoke uses disposable local fixtures and bounded official resolver
code with container networking disabled. It requires Docker and availability of
the pinned image. It is not a customer compatibility test, a production scan or
an engine/model benchmark. Preserve those acceptance gates separately.

The checked-in source benchmark pins nine vulnerable/patched pairs and three
explicitly unassessed cross-file/authorization/CSRF/session cases. Each fixture
emits a SHA-256 and exact source-rule version with observed CWEs and coverage
limits. The [manifest](../apps/worker/src/engine/scanners/fixtures/php-source/manifest.json)
and benchmark test own expectations. These are built-in deterministic results;
Semgrep, Trivy, the engine and running-service outcomes require separate runs and
are not inferred from this benchmark.
