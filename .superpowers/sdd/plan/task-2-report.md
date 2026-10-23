# Task 2 report — passive PHP runtime evidence

Implemented in isolated worktree `php-detection-fix-workflows` on `codex/php-detection-fix-workflows`. No primary-checkout changes, provider actions, paid scans, engine pin updates, pushes or deployments.

## Behavior and interfaces

Repository runtime declarations reuse `scannerSource: iac`. Public response banners reuse `scannerSource: url`. Runtime finding classes are `php_runtime_cve`, `php_runtime_eol`, `php_runtime_config` and `php_runtime_banner`. All carry `runtime_verified: false`; no runtime verification receipt is produced.

- The existing IaC traversal now discovers `composer.json`, `php-runtime.json` and `php.ini` alongside Dockerfiles and Compose. PHP source presence is counted from file metadata, without reading or executing PHP. Existing 50,000-entry, depth-40 and 512-KiB limits remain. Symlink inputs are skipped and cause explicit partial coverage. Oversized/unreadable/bounded discovery and finding caps remain explicit.
- Exact stable official PHP image tags and exact `composer.json` `config.platform.php` strings are source declarations. Composer requirements such as `^8.4` are not runtime identity. Docker image variables, floating tags, prereleases, custom image names, digest-only images and malformed identities get coverage issues. An identity in one subtree does not cover unrelated PHP source trees.
- Dockerfile edits use existing `code_locations: [{ file, start_line, fix_before, fix_after }]`, with **both fix fields containing the entire file**. Only an exact recognized official mutable tag on its FROM line is changed. The version is updated within the same supported branch to the latest fixed version retained by the catalog; the existing suffix, stage name, platform flag and file content are preserved. No image digest is stripped, created or changed. Digest-pinned declarations receive findings but no structured edit. Files over 16,000 characters receive no structured edit. Compose, Composer platform and inventory declarations receive no automatic edits. EOL branches require a supported upgrade after compatibility testing, with no automatic major migration.
- Configuration declarations warn conservatively for `display_errors = On/1/true` and `allow_url_include = On/1/true`; active configuration and deployment overrides remain unknown. There is no suggested `memory_limit=-1` mitigation or exploit code.
- URL detection inspects only the already-collected document's `Server` and `X-Powered-By` response headers for `PHP/version`. It creates a low-information, unverified banner lead, never a CVE assertion. It adds no requests or probes and does not inspect HTML text for runtime identity.
- Runtime output expansion is capped at 100 candidates per file before IaC integration, which retains its existing per-file/total caps. Compose parses at most 256 services, disallows duplicate keys and alias expansion, and reports incomplete input. PHP inventory is limited to 64 KiB. JSON syntax and duplicate keys are checked; inventory extensions must be unique.

### Supporting `php-runtime.json` format

One strict object per file. Required: `schemaVersion: 1` (number), `version` (exact stable `major.minor.patch` string, no range, prerelease, vendor suffix or leading zeros). Unknown object keys are rejected.

```json
{
  "schemaVersion": 1,
  "version": "8.4.26",
  "sapi": "fpm",
  "extensions": ["openssl", "soap", "pgsql"],
  "os": "linux",
  "image": "php:8.4.26-fpm-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "vendorPackage": "php8.4-fpm-8.4.26-vendor1",
  "backports": ["CVE-2026-109618"],
  "replicas": 2
}
```

Optional fields:

| Field | Accepted value |
| --- | --- |
| `sapi` | `cli`, `fpm`, `cgi`, `apache2handler`, `frankenphp`, `litespeed` |
| `extensions` | At most 128 unique lower-case names, each 1–64 `[a-z0-9_]` characters. Absent means unknown; empty means reporter declares none. |
| `os` | `linux`, `windows`, `other`; absent means unknown. |
| `image` | Nonempty string, at most 256 characters. Retained as a report, never resolved against a registry. A conflicting exact recognized official-tag version causes a coverage issue. |
| `vendorPackage` | Nonempty string, at most 256 characters. Retained as a report; no package execution or vendor verification. |
| `backports` | At most 64 CVE/GHSA IDs. Claims do not suppress a matching core advisory and always cause an independent-verification coverage issue. |
| `replicas` | Integer 1–100000. Context only: does not assert active instances, count actual replicas, establish deployment coverage or influence verification. |

Inventory findings use `evidence_scope: user_reported`. Source declarations use `source_declaration`; URL headers use `public_banner`. Declared absent extensions or incompatible SAPI/OS can exclude conditional candidates for that declaration; omitted fields preserve applicable candidates with explicit uncertainty. Neither inclusion nor exclusion establishes installed-runtime behavior. Inventory backports, images, packages and replica counts are never upgraded into trusted runtime evidence. Independent runtime, vendor, image and all-serving-replica proof remains required after rebuild/deploy/restart; source-only retests cannot establish runtime remediation.

`dependency_metadata` remains a bounded flat record, with runtime version, evidence scope, catalog version, SAPI/extensions/OS, reported image/vendor package/replicas, advisory ID/primary URL, exact branch range/fixed version, applicability and backport claim. `fixed_version` records the individual advisory fix, while remediation and generated mutable-tag updates choose the latest fixed release retained for that branch.

## Catalog and provenance

Pinned catalog version: `php-maintainers-2026-10-23.1` (schema 1), containing all **29 maintainer advisories published in 2026**, including older-year CVE identifiers and `GHSA-ch8v-r6jh-4vvr` without a CVE. Three older KEV PHP advisories are included: CVE-2024-4577, CVE-2019-11043, CVE-2012-1823. This is selected older coverage, not an exhaustive historical PHP catalog.

Exact source `< fixed` ranges are scoped to their stated PHP branch. CVE-2026-93682 also retains the maintainer's explicit introduced lower bounds (8.2.28/8.3.18/8.4.5/8.5.0). Strict startup validation rejects cross-branch/ambiguous/duplicate ranges. Latest PHP2Shell fixed releases are 8.2.35, 8.3.36, 8.4.27 and 8.5.12. Catalog maintenance is a reviewed source update; there are no runtime advisory fetches.

Primary sources: [PHP maintainer advisories](https://github.com/php/php-src/security/advisories), [PHP 7 changelog](https://www.php.net/ChangeLog-7.php), [PHP 5 changelog](https://www.php.net/ChangeLog-5.php), [PHP supported branches](https://www.php.net/supported-versions.php), [CISA KEV](https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json). Maintainer records come from the retained verified research JSON and CSV inventories. Only bounded advisory facts/primary links were copied; no advisory exploit descriptions or payloads were copied. PHP 7/5 changelogs and supported-versions were checked live during this task.

SHA-256 provenance:

- Retained `php-advisories.json`: `18683c1f26494e31b0c49baba67ebc30eb05cbbf9b6b7b1e7a23890088511ffe`.
- Retained `cisa-kev.json`: `8cb57ba8ca0d2d3a1429a8b503718ffe84e94555d5cd90b5474653b8aa866296`.
- Generated pinned catalog JSON: `2085530c3ce8031790b824565e8c1f99360c7b7f721a3e2cc068c55d73936f83`.

## Test-first evidence and checks

1. Initial RED: `pnpm exec vitest run apps/worker/src/engine/scanners/php-runtime.test.ts` — **18 failed, 5 passed** against existing IaC behavior, for missing runtime findings, declarations/config inventory and coverage gaps. Real disposable filesystem fixtures; no uploaded PHP execution.
2. Initial GREEN: runtime plus existing IaC suite — **36/36 passed**.
3. Boundary/URL RED: runtime plus URL tests — **5 failed, 61 passed** (future-branch EOL, unsupported suffix edit, conflicting inventory identity, unrelated-source identity and missing passive banner). Then GREEN across runtime/IaC/URL — **79/79 passed**.
4. Strict parser RED: runtime suite — **3 failed, 37 passed** (duplicate inventory JSON keys, duplicate extension names and duplicate Composer platform keys). Then GREEN across runtime/IaC/URL — **84/84 passed**.
5. Candidate-expansion RED: direct runtime matcher — returned **54,000 candidates**, failing the required <=100 bound. Then GREEN after bounding expansion. Integration already capped output; this test caught internal expansion before integration.
6. Final raw focused suites: `pnpm exec vitest run apps/worker/src/engine/scanners/php-runtime.test.ts apps/worker/src/engine/scanners/php-runtime-catalog.test.ts apps/worker/src/engine/scanners/iac-scanner.test.ts apps/worker/src/engine/scanners/url-scanner.test.ts` — **4 files, 99 tests passed**.
7. Focused raw ESLint, Prettier check and `git diff --check` passed. Catalog integrity assertions independently list the retained 29 IDs and reject ambiguous range data. One initially mistyped GHSA literal in the test was corrected from the retained source; this is not counted as a feature RED.
8. Worker typecheck initially revealed the composite-project JSON include requirement; added explicit `src/**/*.json` to worker tsconfig. A later run was temporarily blocked by root-owned in-progress result-integrity TS2339 errors; latest run was blocked only by root-owned `jobs/composer-fix-proposal.ts:166-167` TS2322 (`string | undefined` to `string`). No Task 2 type errors remained. Root will run the final integrated typecheck.
9. Extracted existing IaC rules verbatim into `iac-rules.ts` and bounded PHP parsing/finding/catalog helpers. No increased size debt. Root owns the shared downward size-baseline refresh; the previous IaC oversized file debt is removed and its function debt reduced.

No browser/product UI changed. Full repo CI/build, production deployment, runtime inventory verification and provider acceptance are outside this task's local evidence and are not asserted complete.
