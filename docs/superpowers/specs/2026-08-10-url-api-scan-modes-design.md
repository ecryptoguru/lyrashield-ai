# URL and API Scan Modes Design

Date: 2026-08-10
Status: approved for implementation planning
Related audit: `docs/plans/2026-08-10-vibe-security-50-integrity-audit.md`

## Decision

URL and API targets use one honest mode until deeper capabilities exist. The final product keeps the familiar `SAFE`, `STANDARD`, and `DEEP` values, but their names and execution contracts are target-specific. A mode is exposed only after its worker implementation, coverage receipts, regression corpus, API enforcement, and rendered UX are complete.

No URL or API mode invokes the external engine in this project. The application currently skips the engine for non-repository targets because engine-originated network traffic is not forced through the worker's DNS-pinned, redirect-validating transport. Model-assisted URL review is a separate cross-repository project requiring enforced egress and an evaluation corpus.

## Product contract

### Web application targets

| Stored mode | Product name              | Capability                                                                                                                                                                                                                                                                |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE`      | Surface Review            | Fetch the exact submitted page and up to 6 same-origin JavaScript or CSS assets. Perform passive public-surface analysis only.                                                                                                                                            |
| `STANDARD`  | Expanded Surface Review   | Safe plus bounded same-origin discovery from links, `robots.txt`, and sitemaps. Review at most 20 documents at depth 2 and 30 assets within a 25 MiB total body budget. Validate referenced same-origin source maps.                                                      |
| `DEEP`      | Behavioral Surface Review | Standard plus controlled `HEAD`, `OPTIONS`, and alternate-`Origin` requests. Compare route-level headers, CORS behavior, cache controls, and cookie behavior. Review at most 40 documents, 50 assets, 20 method probes, and 10 origin probes within a 50 MiB body budget. |

### API targets

| Stored mode | Product name             | Capability                                                                                                                                                                                                                                                      |
| ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE`      | Endpoint Review          | Fetch one exact public endpoint and inspect transport, headers, exposed credentials, cookies, verbose errors, and response metadata.                                                                                                                            |
| `STANDARD`  | Contract Review          | Require a stored OpenAPI document URL. Statically inspect the contract and execute at most 10 parameter-free, unauthenticated `GET` or `HEAD` operations.                                                                                                       |
| `DEEP`      | Contract Behavior Review | Standard plus at most 25 unauthenticated `GET`, `HEAD`, or `OPTIONS` operations. Required parameters may be populated only from documented examples, defaults, or a first enum value. Compare declared status/content types and perform controlled CORS probes. |

`QUICK` is accepted as a legacy API alias for `SAFE` but is never displayed for URL or API targets. `CUSTOM` is rejected for URL and API targets. Repository mode behavior is unchanged.

## Current-release behavior

Until Standard and Deep reach their release gates:

- the dashboard shows only Surface Review for `WEB_APP` and Endpoint Review for `API`;
- the scan API rejects unsupported URL modes with `URL_MODE_UNAVAILABLE`;
- schedules cannot be created or updated with unavailable URL modes;
- historical scans retain their stored mode for auditability;
- existing URL schedules using `STANDARD` or `DEEP` are disabled by a data migration and must be explicitly re-enabled after the matching capability ships.

This avoids silently changing a recurring scan's behavior.

## Request safety contract

All modes inherit `checkScanUrlSafe`, `resolveScanUrlSafe`, and `safeFetchDetailed`.

Every request must satisfy all of these rules:

1. Only `http:` and `https:` targets are accepted.
2. Credentials, fragments, and query strings are rejected on user-supplied target and OpenAPI URLs.
3. Every hostname is resolved immediately before each request.
4. Every resolved address and redirect target is checked against private, metadata, reserved, multicast, and malformed ranges.
5. Production requests use the configured authenticated egress proxy when available; direct requests retain DNS pinning.
6. Redirects are manual and bounded.
7. Bodies, request counts, traversal depth, total bytes, wall time, and concurrency are bounded by the selected profile.
8. Discovered web URLs must remain on the target's exact origin. Query strings and fragments are removed before deduplication and fetching. API Deep may construct query parameters only from non-sensitive values explicitly present in the OpenAPI contract; those values are never persisted or logged.
9. No mode sends `POST`, `PUT`, `PATCH`, `DELETE`, `CONNECT`, or `TRACE`.
10. No mode submits forms, attempts login, guesses credentials, fuzzes paths, brute-forces parameters, or executes exploit payloads.
11. Cookies returned by the target are observed but never replayed.
12. Redirects to a different public origin may be followed only as part of the seed redirect chain. Crawling and probes remain on the final seed origin.

## Versioned profiles

The shared package exports a fixed contract:

```ts
export const URL_SCAN_CONTRACT_VERSION = "url-scan/2.0.0" as const

export type UrlTargetType = "WEB_APP" | "API"
export type UrlScanMode = "SAFE" | "STANDARD" | "DEEP"

export type UrlScanProfile = {
  targetType: UrlTargetType
  mode: UrlScanMode
  label: string
  maxDocuments: number
  maxAssets: number
  maxDepth: number
  maxTotalBytes: number
  maxResponseBytes: number
  maxConcurrency: number
  maxWallTimeMs: number
  maxOperations: number
  maxMethodProbes: number
  maxOriginProbes: number
  allowedMethods: readonly ("GET" | "HEAD" | "OPTIONS")[]
  requiresApiSpec: boolean
}
```

The profile registry is code, not environment configuration. A limit change alters scan semantics and therefore requires a contract-version bump and fixtures.

Exact `url-scan/2.0.0` limits:

| Profile            | Documents | Assets | Depth | Total bytes | Response bytes | Concurrency | Wall time | Operations | Method probes | Origin probes |
| ------------------ | --------: | -----: | ----: | ----------: | -------------: | ----------: | --------: | ---------: | ------------: | ------------: |
| `WEB_APP_SAFE`     |         1 |      6 |     0 |       8 MiB |          3 MiB |           3 |      60 s |          0 |             0 |             0 |
| `WEB_APP_STANDARD` |        20 |     30 |     2 |      25 MiB |          3 MiB |           4 |     120 s |          0 |             0 |             0 |
| `WEB_APP_DEEP`     |        40 |     50 |     3 |      50 MiB |          5 MiB |           4 |     180 s |          0 |            20 |            10 |
| `API_SAFE`         |         1 |      0 |     0 |       5 MiB |          5 MiB |           1 |      30 s |          1 |             0 |             0 |
| `API_STANDARD`     |         0 |      0 |     0 |      20 MiB |          2 MiB |           2 |      90 s |         10 |             0 |             0 |
| `API_DEEP`         |         0 |      0 |     0 |      40 MiB |          2 MiB |           2 |     150 s |         25 |             0 |            10 |

The OpenAPI document itself has a 2 MiB cap and consumes the API profile's total-byte and wall-time budgets. A response capped before EOF is explicitly marked truncated and prevents a complete no-finding claim for detectors that depend on the missing bytes.

## Shared collection model

The public Lite Check and authenticated URL scans use the same collector:

```ts
export type SurfaceSubjectKind =
  | "document"
  | "asset"
  | "robots"
  | "sitemap"
  | "source_map"
  | "api_spec"
  | "api_operation"
  | "probe"

export type SurfaceSubject = {
  kind: SurfaceSubjectKind
  requestedUrl: string
  finalUrl: string
  urlHistory: string[]
  method: "GET" | "HEAD" | "OPTIONS"
  status: number
  headers: Record<string, string>
  body: string
  bodyBytes: number
  depth: number
}

export type SurfaceCollectionIssue = {
  code:
    | "FETCH_FAILED"
    | "LIMIT_REACHED"
    | "OUT_OF_SCOPE"
    | "UNSUPPORTED_CONTENT"
    | "AUTHENTICATION_REQUIRED"
    | "PARAMETER_VALUE_UNAVAILABLE"
    | "SCHEMA_UNSUPPORTED"
  subject: string
  reason: string
}

export type SurfaceCollection = {
  seedUrl: string
  finalOrigin: string
  contractVersion: typeof URL_SCAN_CONTRACT_VERSION
  profile: UrlScanProfile
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  totalBytes: number
  truncated: boolean
}
```

Raw bodies exist only in worker memory. They are not stored in scan events, database rows, manifests, evidence metadata, logs, or public payloads.

`urlHistory` is retained only in worker memory so transport and redirect analysis can distinguish a direct HTTPS response from an HTTP-to-HTTPS upgrade. Persisted evidence may contain only redacted, query-free subject URLs and aggregate counts.

## Shared analysis model

One neutral analyzer owns public-surface interpretation. Lite and authenticated adapters consume the same signals:

```ts
export type SurfaceSignal = {
  id: string
  subjectUrl: string
  controlIds: readonly number[]
  state: "DETECTED" | "OBSERVED"
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  title: string
  description: string
  remediation?: string
  evidence: Record<string, string | number | boolean | string[]>
}
```

The analyzer owns:

- privileged credential detection without retaining matched values;
- CSP quality and `frame-ancestors` equivalence;
- HSTS only on HTTPS responses;
- `nosniff`, Referrer Policy, and Permissions Policy observations;
- sensitive-cookie attributes;
- cleartext redirect history and mixed content;
- verbose error signatures;
- source-map reference versus successfully fetched source map;
- public Supabase/Firebase markers as observations, never secret findings;
- CORS findings only from controlled probe evidence;
- route inconsistency observations with exact subject scope.

Missing headers are described as hardening gaps tied to that header. They are not described as generic proof of exploitation.

## Web discovery

Standard and Deep web collection use these deterministic sources in order:

1. Final seed document.
2. Same-origin anchor URLs from collected HTML.
3. `/robots.txt` and same-origin sitemap URLs named by it.
4. `/sitemap.xml` when no sitemap was named.
5. Same-origin `<loc>` values from bounded sitemap XML.
6. Same-origin JavaScript and CSS assets referenced by collected documents.
7. Same-origin source maps referenced by collected assets, within the profile's asset budget.

URLs are normalized by removing credentials, fragments, and query strings, normalizing the hostname, preserving the path, and sorting lexicographically before breadth-first traversal. This makes subject selection reproducible.

Malformed HTML/XML links, unsupported content types, oversized bodies, and exhausted budgets become collection issues. They do not fail the whole scan unless the seed URL cannot be fetched.

## Behavioral probes

Deep web/API probes are selected deterministically from collected subjects and OpenAPI operations.

- `HEAD` compares status and security-relevant headers with the corresponding `GET`.
- `OPTIONS` records declared allowed methods; it never invokes them.
- An alternate-origin `GET` uses `Origin: https://lyrashield.invalid` and no cookies or authorization.
- A reflected exact origin with `Access-Control-Allow-Credentials: true` is a control-14 finding.
- Wildcard origin plus credentials is recorded as an invalid configuration observation, not described as a successful credentialed browser read.
- Probe responses consume the same byte and wall-time budgets as collection.

## OpenAPI contract

API Standard and Deep require `Target.apiSpecUrl`.

The scanner:

1. Fetches at most 2 MiB through `safeFetchDetailed`.
2. Parses JSON first, then YAML with the existing `yaml` package added as a direct worker dependency.
3. Accepts OpenAPI 3.x objects with at most 500 path entries.
4. Resolves only local JSON Pointer references. Remote `$ref` values become `SCHEMA_UNSUPPORTED` issues and are never fetched.
5. Resolves each operation against the target's final origin. Other origins are out of scope and are not requested.
6. Sorts operations by path and method before applying limits.
7. Executes only unauthenticated safe methods.
8. Skips security-required operations with `AUTHENTICATION_REQUIRED`.
9. Uses only documented `example`, first `examples` value, `schema.default`, or first `schema.enum` value for required parameters.
10. Populates path and query parameters only. Header and cookie parameters are not sent. Parameters with authentication- or secret-like names such as `authorization`, `api_key`, `token`, `secret`, `password`, or `cookie` are never populated, even if the contract contains an example.
11. Skips operations whose required parameters remain unresolved or sensitive.
12. Percent-encodes substituted path and query values, then rechecks the completed URL against the exact target origin before fetching.
13. Compares actual status and content type with declared responses.
14. Validates inline top-level JSON `type`, `required`, and primitive property types. Unsupported composition or remote references become limitations rather than failures.

An OpenAPI URL can be created or updated only by a member with `target:update`. It is SSRF-validated on write and again at scan time.

## Persistence and evidence

The immutable result manifest adds:

```ts
urlExecution: {
  contractVersion: "url-scan/2.0.0"
  profile: "WEB_APP_SAFE" | "WEB_APP_STANDARD" | "WEB_APP_DEEP" |
           "API_SAFE" | "API_STANDARD" | "API_DEEP"
  methods: ("GET" | "HEAD" | "OPTIONS")[]
  subjectCount: number
  documentCount: number
  assetCount: number
  operationCount: number
  methodProbeCount: number
  originProbeCount: number
  totalBytes: number
  truncated: boolean
  issueCodes: string[]
} | null
```

Subject URLs stored in evidence or receipts use the existing redaction boundary: credentials, query strings, and fragments are removed. Logs use `redactUrlForLogs`.

`NO_FINDING` requires an explicit completed deterministic method and subject scope. A limit, failed fetch, missing API parameter, required authentication, unsupported schema, or unattempted operation produces `INCONCLUSIVE`/`BLOCKED`, not `NO_FINDING`.

## UX contract

When a repository target is selected, existing repository presets are unchanged.

When a web target is selected:

- the cards use Surface Review, Expanded Surface Review, and Behavioral Surface Review;
- each card lists its actual page/request bounds;
- unavailable modes are not selectable;
- the estimate is derived from the selected URL profile, not repository estimates.

When an API target is selected:

- the cards use Endpoint Review, Contract Review, and Contract Behavior Review;
- without an OpenAPI URL, only Endpoint Review is selectable;
- the UI links to target settings with the message “Add an OpenAPI document to unlock Contract Review.”

Scan detail and reports show:

- mode name;
- attempted methods;
- subjects reviewed;
- limits reached;
- inconclusive reasons;
- the statement that non-mutating public review is not authenticated or exploit validation.

The UI never asks users to infer coverage by opening 50 controls individually. It summarizes needs attention, no issue found in stated scope, needs evidence, and not assessed.

## Release gates

A mode is enabled only when all of these pass:

1. Positive, negative, and adversarial fixtures for every detector added by the mode.
2. SSRF tests for seed, discovered links, redirects, sitemaps, source maps, OpenAPI servers, and operation URLs.
3. Request-method tests proving no disallowed method can be sent.
4. Byte, count, depth, concurrency, and timeout limit tests.
5. Coverage-receipt tests for completed, limited, out-of-scope, authentication-required, and parameter-unavailable cases.
6. Worker lint and typecheck.
7. Focused worker/security/web tests.
8. Web production build.
9. Desktop and 390 px mobile browser verification of target creation, mode selection, missing-spec guidance, progress, and result coverage.
10. No paid live scan is required for local acceptance. A production smoke uses only an approved public target after deployment authorization.

## Explicitly excluded

- Login/session automation.
- Credential storage or replay.
- Browser JavaScript execution.
- State-changing API methods.
- Fuzzing, brute force, exploit payloads, or arbitrary path enumeration.
- Direct engine network access.
- Claims that Safe, Standard, or Deep verify all Vibe Security 50 controls.

Those capabilities require separate trust-boundary designs rather than incremental flags in this scanner.
