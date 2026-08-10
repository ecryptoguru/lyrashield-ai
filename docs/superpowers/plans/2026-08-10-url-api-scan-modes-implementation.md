# URL and API Scan Modes Implementation Plan

> **For agentic workers:** Use the available `executing-plans` workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cosmetic URL depth selector with one shared Safe surface scanner, then add genuinely deeper Standard and Deep web/API capabilities backed by bounded requests, explicit receipts, target-aware UX, and regression fixtures.

**Architecture:** `@lyrashield/types` owns the versioned target/mode profile registry. `@lyrashield/security` owns SSRF-safe public-surface collection and neutral analysis shared by Lite Check and authenticated scans. The worker adds bounded web behavior and OpenAPI execution adapters, then persists only findings, scoped coverage, and aggregate execution metadata; raw response bodies remain in memory. Repository scans and the external engine boundary remain unchanged.

**Tech Stack:** TypeScript 6, Next.js 16 App Router, React, Zod 4, Prisma 7/Postgres, BullMQ, Vitest, Astro 7, `yaml` 2.7, existing `safeFetchDetailed`, existing egress proxy, existing evidence/manifest pipeline.

## Global Constraints

- Work in `/Users/defiankit/Desktop/lyrashieldai` on `codex/vibe-50-integrity-repair`.
- Preserve every existing uncommitted change; never reset, checkout, clean, or overwrite the working tree.
- Read `AGENTS.md`, `docs/superpowers/specs/2026-08-10-url-api-scan-modes-design.md`, and `docs/plans/2026-08-10-vibe-security-50-integrity-audit.md` before editing.
- Do not rename `@lyrashield/*`, `LYRASHIELD_*`, LyraShield AI, or `lyrashieldai.com`.
- Do not invoke the external engine for `WEB_APP` or `API` targets.
- Do not add browser execution, credentials, login automation, state-changing methods, fuzzing, arbitrary path enumeration, or exploit payloads.
- Every outbound URL and redirect must pass the existing DNS-aware SSRF guard immediately before the request.
- Never persist raw response bodies, matched credential values, authorization material, URL credentials, query strings, or fragments.
- A mode is not selectable until its backend implementation and release-gate tests pass.
- `NO_FINDING` means only that a completed deterministic method returned no mapped finding for its recorded subjects.
- `QUICK` is a hidden legacy alias for URL `SAFE`; URL `CUSTOM` is rejected.
- Keep repository scan presets and engine routing unchanged.
- Use existing dependencies where possible. Add `yaml` directly to `apps/worker` for OpenAPI YAML parsing; add no crawler, browser, or OpenAPI framework.
- Do not run a paid provider scan or deploy production as part of this plan.

---

## File structure

### New files

- `packages/types/src/url-scan-capabilities.ts` — pure versioned profile registry and target-aware mode availability.
- `packages/types/src/url-scan-capabilities.test.ts` — exact profile and legacy-mode contract tests.
- `packages/security/src/public-surface.ts` — shared bounded collection types, URL normalization, Lite/Safe page-and-asset collection, and deterministic discovery helpers.
- `packages/security/src/public-surface.test.ts` — SSRF, same-origin, limit, ordering, and redaction fixtures.
- `packages/security/src/public-surface-analysis.ts` — neutral signal analysis shared by Lite and authenticated adapters.
- `packages/security/src/public-surface-analysis.test.ts` — positive, negative, and near-miss detector corpus.
- `apps/worker/src/engine/scanners/url-behavior-probes.ts` — Deep-only safe `HEAD`/`OPTIONS`/alternate-origin probes.
- `apps/worker/src/engine/scanners/url-behavior-probes.test.ts` — method allowlist, CORS, limit, and cancellation tests.
- `apps/worker/src/engine/scanners/openapi-scanner.ts` — OpenAPI parsing, deterministic operation selection, bounded safe execution, and contract comparison.
- `apps/worker/src/engine/scanners/openapi-scanner.test.ts` — JSON/YAML, scope, parameter, auth, response, and limit fixtures.
- `apps/web/src/app/api/targets/[id]/route.ts` — permission-gated API-spec URL update endpoint.
- `apps/web/src/app/api/targets/[id]/route.test.ts` — tenant, permission, validation, and audit tests.
- `apps/web/src/app/api/schedules/route.test.ts` — create-time target/mode admission tests.
- `apps/web/src/app/api/schedules/[id]/route.test.ts` — update/re-enable target/mode admission tests.
- `apps/web/src/app/(dashboard)/dashboard/targets/[id]/api-spec-settings.tsx` — API target OpenAPI settings form.
- `packages/db/prisma/migrations/20260810000000_add_target_api_spec_url/migration.sql` — nullable `Target.apiSpecUrl` column.

### Existing files with focused changes

- `packages/types/src/index.ts` and `packages/types/src/index.test.ts` — URL target input and scan-mode validation exports.
- `packages/security/src/index.ts`, `packages/security/src/lite-scan.ts`, and `packages/security/src/lite-scan.test.ts` — shared collector/analyzer adapters.
- `apps/web/src/app/api/lite-scan/route.ts` and its tests — replace inline asset fetching with shared Safe collection.
- `apps/web/src/app/api/targets/route.ts` — create-time API-spec validation/storage.
- `apps/web/src/app/api/scans/route.ts` and `route.test.ts` — backend capability enforcement.
- `apps/web/src/app/api/schedules/route.ts`, schedule update route, and tests — capability enforcement for recurring scans.
- `apps/web/src/app/(dashboard)/dashboard/targets/targets-client.tsx` — OpenAPI URL field for API creation.
- `apps/web/src/app/(dashboard)/dashboard/targets/[id]/page.tsx` — show API-spec state and settings.
- `apps/web/src/lib/scan-presets.ts` and tests — target-aware mode names/options/estimates.
- `apps/web/src/app/(dashboard)/dashboard/scans/scans-client.tsx` — target-aware cards and unavailable-mode guidance.
- `apps/web/src/app/(dashboard)/dashboard/schedules/schedules-client.tsx` — target-aware recurring mode choices.
- `apps/worker/src/engine/scanners/url-scanner.ts` and tests — profile-driven shared collection and finding adapter.
- `apps/worker/src/engine/scanner-orchestrator.ts` and tests — pass the resolved profile and merge OpenAPI/probe results.
- `apps/worker/src/jobs/run-scan.job.ts` and tests — remove URL model-budget events and persist URL execution metadata.
- `apps/worker/src/engine/result-integrity.ts` and tests — profile-scoped receipts and limitations.
- `packages/db/prisma/schema.prisma` — add `Target.apiSpecUrl`.
- `packages/db/src/report-generator.ts` and tests — render URL execution scope.
- `apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client.tsx` — render mode/method/subject limitations.
- `apps/worker/package.json` and `pnpm-lock.yaml` — direct `yaml` dependency.
- `userguide.md`, `codebase.md`, `PRD.md`, `AGENTS.md`, and relevant marketing copy/tests — truthful mode documentation.

---

### Task 0: Protect and checkpoint the existing integrity repair

**Files:**

- Inspect: every path listed by `git status --short`
- Verify: the focused Vibe Security 50 test set from the preceding audit

**Interfaces:**

- Consumes: the uncommitted `vibe-security-50/1.1.0` repair already present in the workspace.
- Produces: a clean, reviewable baseline commit before URL-mode work begins.

- [ ] **Step 1: Confirm the branch and preserve the working tree**

Run:

```bash
git branch --show-current
git status --short
git diff --check
```

Expected: branch is `codex/vibe-50-integrity-repair`; the status contains the Vibe Security integrity files and no merge-conflict markers; `git diff --check` exits 0.

- [ ] **Step 2: Re-run the integrity baseline**

Run:

```bash
pnpm exec vitest run \
  packages/security/src/vibe-security-controls.test.ts \
  apps/worker/src/engine/scanners/url-scanner.test.ts \
  apps/worker/src/engine/scanners/secrets-scanner.test.ts \
  apps/worker/src/engine/scanners/agent-config-scanner.test.ts \
  apps/worker/src/engine/result-integrity.test.ts \
  apps/worker/src/engine/scanner-orchestrator.test.ts \
  apps/worker/src/jobs/run-scan.job.test.ts \
  packages/db/src/score-service.test.ts \
  packages/db/src/report-generator.test.ts
```

Expected: 9 files pass. If a failure exists, diagnose it without discarding any diff.

- [ ] **Step 3: Commit only the existing integrity repair**

Review the staged names before committing:

```bash
git add AGENTS.md PRD.md codebase.md docs/vibe-security-50.md docs/plans/2026-08-10-vibe-security-50-integrity-audit.md \
  apps/marketing/src apps/worker/src packages/db/src packages/security/src
git diff --cached --stat
git commit -m "fix(security): make Vibe 50 outcomes evidence-bounded"
```

Expected: the commit contains the existing integrity repair and public-claim reconciliation. Do not stage the URL/API design or implementation-plan documents in this baseline commit.

---

### Task 1: Add the versioned URL/API capability registry

**Files:**

- Create: `packages/types/src/url-scan-capabilities.ts`
- Create: `packages/types/src/url-scan-capabilities.test.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**

- Consumes: existing Prisma-compatible target strings and scan-mode strings.
- Produces: `URL_SCAN_CONTRACT_VERSION`, `UrlScanProfile`, `getUrlScanProfile()`, and `getUrlModeAvailability()` for web API validation, dashboard presentation, and worker execution.

- [ ] **Step 1: Write failing profile tests**

Create tests asserting the exact contracts:

```ts
import { describe, expect, it } from "vitest"
import {
  URL_SCAN_CONTRACT_VERSION,
  getUrlModeAvailability,
  getUrlScanProfile,
} from "./url-scan-capabilities"

describe("URL scan capabilities", () => {
  it("defines reproducible web limits", () => {
    expect(URL_SCAN_CONTRACT_VERSION).toBe("url-scan/2.0.0")
    expect(getUrlScanProfile("WEB_APP", "SAFE")).toMatchObject({
      id: "WEB_APP_SAFE",
      maxDocuments: 1,
      maxAssets: 6,
      maxDepth: 0,
      maxTotalBytes: 8 * 1024 * 1024,
      allowedMethods: ["GET"],
    })
    expect(getUrlScanProfile("WEB_APP", "STANDARD")).toMatchObject({
      id: "WEB_APP_STANDARD",
      maxDocuments: 20,
      maxAssets: 30,
      maxDepth: 2,
      maxTotalBytes: 25 * 1024 * 1024,
    })
    expect(getUrlScanProfile("WEB_APP", "DEEP")).toMatchObject({
      id: "WEB_APP_DEEP",
      maxDocuments: 40,
      maxAssets: 50,
      maxMethodProbes: 20,
      maxOriginProbes: 10,
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
    })
  })

  it("requires an OpenAPI URL for API Standard and Deep", () => {
    expect(getUrlModeAvailability("API", "SAFE", false)).toEqual({ available: true })
    expect(getUrlModeAvailability("WEB_APP", "STANDARD", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Expanded Surface Review is not available yet.",
    })
    expect(getUrlModeAvailability("API", "STANDARD", false)).toEqual({
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "Contract Review is not available yet.",
    })
  })

  it("maps legacy Quick to Safe and rejects Custom", () => {
    expect(getUrlScanProfile("WEB_APP", "QUICK").id).toBe("WEB_APP_SAFE")
    expect(() => getUrlScanProfile("WEB_APP", "CUSTOM")).toThrow("URL_MODE_UNSUPPORTED")
  })
})
```

- [ ] **Step 2: Run the tests and observe the missing module**

Run:

```bash
pnpm exec vitest run packages/types/src/url-scan-capabilities.test.ts
```

Expected: FAIL because `url-scan-capabilities.ts` does not exist.

- [ ] **Step 3: Implement the flat profile registry**

Use these exported shapes:

```ts
export const URL_SCAN_CONTRACT_VERSION = "url-scan/2.0.0" as const

export type UrlTargetType = "WEB_APP" | "API"
export type UrlScanMode = "SAFE" | "STANDARD" | "DEEP"
export type UrlRequestMethod = "GET" | "HEAD" | "OPTIONS"

export type UrlScanProfile = {
  id:
    "WEB_APP_SAFE" | "WEB_APP_STANDARD" | "WEB_APP_DEEP" | "API_SAFE" | "API_STANDARD" | "API_DEEP"
  targetType: UrlTargetType
  mode: UrlScanMode
  label: string
  description: string
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
  allowedMethods: readonly UrlRequestMethod[]
  requiresApiSpec: boolean
}

export type UrlModeAvailability =
  | { available: true }
  | {
      available: false
      code: "URL_MODE_UNAVAILABLE" | "URL_MODE_UNSUPPORTED" | "API_SPEC_REQUIRED"
      reason: string
    }
```

Implement one `as const satisfies` registry and a code-owned `RELEASED_URL_PROFILE_IDS` set. In this first commit the set contains only `WEB_APP_SAFE` and `API_SAFE`; Tasks 5, 6, and 8 add profile IDs only after their implementation tests pass. `getUrlScanProfile()` maps `QUICK` to `SAFE`, throws `new Error("URL_MODE_UNSUPPORTED")` for `CUSTOM`, and performs no environment reads. `getUrlModeAvailability()` checks release state before the API-spec requirement, so an unfinished capability is never advertised merely because a target has a spec.

Encode every exact numeric limit from the design's `url-scan/2.0.0` table. Add one table-driven test that snapshots all six profiles so an accidental limit change cannot pass through partial `toMatchObject()` assertions.

- [ ] **Step 4: Export and verify the contract**

Run:

```bash
pnpm exec vitest run packages/types/src/url-scan-capabilities.test.ts packages/types/src/index.test.ts
pnpm --filter @lyrashield/types typecheck
```

Expected: both test files and typecheck pass.

- [ ] **Step 5: Commit the capability contract**

```bash
git add packages/types/src/url-scan-capabilities.ts packages/types/src/url-scan-capabilities.test.ts packages/types/src/index.ts
git commit -m "feat(types): define URL scan capability profiles"
```

---

### Task 2: Extract the shared Safe public-surface collector

**Files:**

- Create: `packages/security/src/public-surface.ts`
- Create: `packages/security/src/public-surface.test.ts`
- Modify: `packages/security/src/safe-fetch.ts`
- Modify: `packages/security/src/safe-fetch.test.ts`
- Modify: `packages/security/src/index.ts`
- Modify: `apps/web/src/app/api/lite-scan/route.ts`
- Modify: `apps/web/src/app/api/lite-scan/route.test.ts`

**Interfaces:**

- Consumes: `UrlScanProfile`, `safeFetchDetailed`, optional `fetchFn`, resolver, and abort signal.
- Produces: `collectPublicSurface(options): Promise<SurfaceCollection>` with in-memory bodies and bounded issues.

- [ ] **Step 1: Write failing collector tests**

Cover these behaviors with injected fetch/resolver fixtures:

```ts
it("collects the seed and at most six same-origin assets for Safe", async () => {
  const result = await collectPublicSurface({
    seedUrl: "https://example.com/",
    profile: getUrlScanProfile("WEB_APP", "SAFE"),
    fetchFn,
    resolver: publicResolver,
  })
  expect(result.subjects.filter((s) => s.kind === "document")).toHaveLength(1)
  expect(result.subjects.filter((s) => s.kind === "asset")).toHaveLength(6)
  expect(result.subjects.every((s) => new URL(s.finalUrl).origin === "https://example.com")).toBe(
    true
  )
})

it("drops query and fragment data from discovered URLs", async () => {
  const result = await collectPublicSurface(fixtureWithLink("/account?token=secret#profile"))
  expect(result.subjects.map((s) => s.requestedUrl)).not.toContain(
    "https://example.com/account?token=secret#profile"
  )
  expect(result.subjects.map((s) => s.requestedUrl)).toContain("https://example.com/account")
})

it("records a limit instead of claiming complete collection", async () => {
  const result = await collectPublicSurface(oversizedFixture)
  expect(result.truncated).toBe(true)
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "LIMIT_REACHED" }))
})
```

Also test private redirect rejection, cross-origin asset rejection, lexicographic breadth-first ordering, abort propagation, byte accounting, per-response truncation, wall-time cancellation, concurrency bounds, and that no issue reason contains a query string.

- [ ] **Step 2: Run the collector tests and observe failure**

```bash
pnpm exec vitest run packages/security/src/public-surface.test.ts
```

Expected: FAIL because the collector module is absent.

- [ ] **Step 3: Implement collection types and normalization**

Implement the design-spec types and this entry point:

```ts
export async function collectPublicSurface(options: {
  seedUrl: string
  profile: UrlScanProfile
  userAgent?: string
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<SurfaceCollection>
```

First extend `SafeFetchResult` with `bodyBytes: number` and `bodyTruncated: boolean`. Change the bounded reader to return those values without persisting body data. Add compatibility tests proving a short response reports its exact byte count and an oversized response reports `bodyTruncated: true`; existing callers may ignore the new fields.

Use `safeFetchDetailed` for every fetch. Normalize discovered URLs with one function that:

```ts
function normalizeDiscoveredUrl(raw: string, base: string, allowedOrigin: string): string | null {
  const url = new URL(raw, base)
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== allowedOrigin) return null
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString()
}
```

For Safe, collect only the seed document and linked same-origin `.js`, `.mjs`, and `.css` assets. Before each request, pass `maxBytes: Math.min(profile.maxResponseBytes, remainingTotalBytes)`. If no byte budget remains, do not request the subject. Record `LIMIT_REACHED` when `bodyTruncated` is true or a count/byte/wall-time budget prevents collection. Keep bodies only in `SurfaceSubject.body`.

Use one scan-level abort controller for `profile.maxWallTimeMs` and a fixed worker pool capped at `profile.maxConcurrency`; do not create one promise per discovered URL. Combine that controller with the caller's signal and stop scheduling new work after either aborts.

Copy `SafeFetchResult.urlHistory` into each in-memory `SurfaceSubject`. Pass `userAgent` to `safeFetchDetailed`; do not log or persist redirect history.

- [ ] **Step 4: Replace Lite Check's inline asset collector**

Delete `linkedSameOriginAssets()` and `fetchPublicAssets()` from the Lite route. Call:

```ts
const collection = await collectPublicSurface({
  seedUrl: parsed.data.url,
  profile: getUrlScanProfile("WEB_APP", "SAFE"),
  userAgent: "LyraShield-Lite/2.0 (passive public-surface check)",
})
```

If no document subject exists, preserve the existing `422 unreachable` response. Pass the document body, joined asset bodies, headers, status, and final URL into the current `analyzeLiteSurface()` adapter so public response shape remains unchanged.

- [ ] **Step 5: Verify collector and Lite compatibility**

```bash
pnpm exec vitest run packages/security/src/public-surface.test.ts packages/security/src/safe-fetch.test.ts apps/web/src/app/api/lite-scan/route.test.ts apps/marketing/src/tests/lite-scan.test.ts
pnpm --filter @lyrashield/security typecheck
pnpm --filter @lyrashield/web typecheck
```

Expected: all focused tests and both typechecks pass.

- [ ] **Step 6: Commit the shared collector**

```bash
git add packages/security/src/public-surface.ts packages/security/src/public-surface.test.ts packages/security/src/safe-fetch.ts packages/security/src/safe-fetch.test.ts packages/security/src/index.ts apps/web/src/app/api/lite-scan/route.ts apps/web/src/app/api/lite-scan/route.test.ts
git commit -m "refactor(security): share bounded public-surface collection"
```

---

### Task 3: Consolidate Lite and authenticated surface analysis

**Files:**

- Create: `packages/security/src/public-surface-analysis.ts`
- Create: `packages/security/src/public-surface-analysis.test.ts`
- Modify: `packages/security/src/lite-scan.ts`
- Modify: `packages/security/src/lite-scan.test.ts`
- Modify: `packages/security/src/index.ts`
- Modify: `apps/worker/src/engine/scanners/url-scanner.ts`
- Modify: `apps/worker/src/engine/scanners/url-scanner.test.ts`

**Interfaces:**

- Consumes: `SurfaceCollection`.
- Produces: `analyzePublicSurface(collection): SurfaceSignal[]`; Lite maps signals to `LiteCheck`, worker maps `DETECTED` signals to `EngineVulnerability`.

- [ ] **Step 1: Write a shared positive/negative/near-miss corpus**

Tests must include:

```ts
it.each([
  ["Supabase anon JWT", publicAnonFixture, false],
  ["Firebase config", firebaseFixture, false],
  ["Supabase service role", serviceRoleFixture, true],
  ["Stripe publishable key", "pk_live_publicvalue123456", false],
  ["Stripe secret key", stripeSecretFixture, true],
  ["CSP frame-ancestors", headers({ "content-security-policy": "frame-ancestors 'self'" }), false],
])("classifies %s without public-key/header false positives", (_name, fixture, detected) => {
  expect(analyzePublicSurface(fixture).some((signal) => signal.state === "DETECTED")).toBe(detected)
})
```

Add focused assertions for HSTS only on HTTPS, `nosniff`, Referrer Policy, Permissions Policy, sensitive cookie flags, mixed content, verbose errors, source-map reference versus fetched map, and secret-value omission from `JSON.stringify(signals)`.

- [ ] **Step 2: Run the analyzer test and observe failure**

```bash
pnpm exec vitest run packages/security/src/public-surface-analysis.test.ts
```

Expected: FAIL because the analyzer does not exist.

- [ ] **Step 3: Implement the neutral signal analyzer**

Use the exact `SurfaceSignal` shape from the design. Stable IDs are derived from detector ID plus a SHA-256 digest of the normalized subject URL; never include the matched secret.

Required detector IDs:

```ts
const DETECTORS = {
  privilegedSecret: "surface.privileged-secret",
  cspMissing: "surface.csp-missing",
  hstsMissing: "surface.hsts-missing",
  frameProtectionMissing: "surface.frame-protection-missing",
  nosniffMissing: "surface.nosniff-missing",
  referrerPolicyMissing: "surface.referrer-policy-missing",
  permissionsPolicyMissing: "surface.permissions-policy-missing",
  insecureTransport: "surface.insecure-transport",
  mixedContent: "surface.mixed-content",
  insecureCookie: "surface.insecure-cookie",
  verboseError: "surface.verbose-error",
  sourceMapReferenced: "surface.source-map-referenced",
  sourceMapFetched: "surface.source-map-fetched",
  dataLayerObserved: "surface.data-layer-observed",
  frameworkObserved: "surface.framework-observed",
} as const
```

Map security signals to controls 3, 27, 28, 29, 31, or 32. Observations have `state: "OBSERVED"` and do not create authenticated findings.

- [ ] **Step 4: Make both adapters consume shared signals**

Keep `analyzeLiteSurface()` public response-compatible by constructing a one-document collection and mapping signals to its five categories. Replace the worker's detector functions with:

```ts
const collection = await collectPublicSurface({
  seedUrl: targetUrl,
  profile,
  fetchFn,
  resolver,
  signal,
})
const signals = analyzePublicSurface(collection)
return {
  findings: signals.filter(isDetectedSignal).map(toEngineVulnerability),
  collection,
}
```

Change the URL scanner return type to:

```ts
export type UrlScannerResult = {
  findings: EngineVulnerability[]
  execution: UrlExecutionSummary
  issues: SurfaceCollectionIssue[]
}
```

- [ ] **Step 5: Verify shared semantics**

```bash
pnpm exec vitest run packages/security/src/public-surface-analysis.test.ts packages/security/src/lite-scan.test.ts apps/worker/src/engine/scanners/url-scanner.test.ts
pnpm --filter @lyrashield/security typecheck
pnpm --filter @lyrashield/worker typecheck
```

Expected: all pass; existing Lite JSON shape remains unchanged; authenticated findings retain `control_ids`.

- [ ] **Step 6: Commit the analyzer consolidation**

```bash
git add packages/security/src/public-surface-analysis.ts packages/security/src/public-surface-analysis.test.ts packages/security/src/lite-scan.ts packages/security/src/lite-scan.test.ts packages/security/src/index.ts apps/worker/src/engine/scanners/url-scanner.ts apps/worker/src/engine/scanners/url-scanner.test.ts
git commit -m "refactor(security): unify URL surface analysis"
```

---

### Task 4: Ship one honest authenticated Safe URL mode

**Files:**

- Modify: `apps/web/src/app/api/scans/route.ts`
- Modify: `apps/web/src/app/api/scans/route.test.ts`
- Modify: `apps/web/src/lib/scan-presets.ts`
- Create or modify: `apps/web/src/lib/scan-presets.test.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/scans/scans-client.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/schedules/schedules-client.tsx`
- Modify: `apps/worker/src/jobs/run-scan.job.ts`
- Modify: `apps/worker/src/jobs/run-scan.job.test.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.test.ts`

**Interfaces:**

- Consumes: Safe profiles and `UrlScannerResult` from Tasks 1–3.
- Produces: one selectable URL/API mode, backend enforcement, no URL model-budget event, and shared Safe execution.

- [ ] **Step 1: Add failing API enforcement tests**

In `apps/web/src/app/api/scans/route.test.ts`, assert:

```ts
it.each(["STANDARD", "DEEP", "CUSTOM"])("rejects unavailable %s for a URL target", async (mode) => {
  prisma.target.findFirst.mockResolvedValue(webTarget)
  const response = await POST(scanRequest({ mode }))
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: "URL_MODE_UNAVAILABLE" },
  })
  expect(enqueueScanJob).not.toHaveBeenCalled()
})
```

Also prove `SAFE` and legacy `QUICK` enqueue with the `WEB_APP_SAFE` profile while repository modes remain unchanged.

- [ ] **Step 2: Add failing worker event tests**

Assert a URL Safe scan:

```ts
expect(runEngine).not.toHaveBeenCalled()
expect(addScanEvent).not.toHaveBeenCalledWith(
  scanId,
  "budget_cap",
  expect.anything(),
  expect.anything(),
  expect.anything()
)
expect(runScannerOrchestrator).toHaveBeenCalledWith(
  expect.objectContaining({ urlProfile: expect.objectContaining({ id: "WEB_APP_SAFE" }) })
)
```

- [ ] **Step 3: Enforce Safe at the scan API and worker**

After loading the target, call `getUrlModeAvailability()` and return:

```ts
return apiError(
  "URL_MODE_UNAVAILABLE",
  "This URL review depth is not available yet. Use Surface Review.",
  400
)
```

Resolve the URL profile before orchestration. Move budget resolution, `budget_cap`, and model-profile resolution inside the `target.type === "REPO"` branch. Keep evidence-storage checks because authenticated findings and manifests still require durable evidence.

- [ ] **Step 4: Replace URL preset cards with one target-aware option**

Add pure presentation functions:

```ts
export function getManualScanOptions(target: { type: string; hasApiSpec?: boolean }): ScanOption[]
```

For `WEB_APP`, return only Safe “Surface Review.” For `API`, return only Safe “Endpoint Review.” Repository targets continue returning Release Check, Code Review, and Deep Security Review.

Do not show repository phrases such as “Repo + deps” or “Cross-file deep” for URL targets. Use a URL Safe estimate of `1–2 min` until measured telemetry supports a narrower value.

- [ ] **Step 5: Verify Safe end to end**

```bash
pnpm exec vitest run apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.test.ts apps/worker/src/jobs/run-scan.job.test.ts apps/worker/src/engine/scanner-orchestrator.test.ts apps/worker/src/engine/scanners/url-scanner.test.ts
pnpm --filter @lyrashield/web typecheck
pnpm --filter @lyrashield/worker typecheck
```

Expected: all pass; the external engine and budget event are absent for URL targets.

- [ ] **Step 6: Commit the honest Safe mode**

```bash
git add apps/web/src/app/api/scans/route.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.ts apps/web/src/lib/scan-presets.test.ts apps/web/src/app/'(dashboard)'/dashboard/scans/scans-client.tsx apps/web/src/app/'(dashboard)'/dashboard/schedules/schedules-client.tsx apps/worker/src/jobs/run-scan.job.ts apps/worker/src/jobs/run-scan.job.test.ts apps/worker/src/engine/scanner-orchestrator.ts apps/worker/src/engine/scanner-orchestrator.test.ts
git commit -m "fix(scans): expose one honest URL surface mode"
```

---

### Task 5: Implement Standard web discovery

**Files:**

- Modify: `packages/security/src/public-surface.ts`
- Modify: `packages/security/src/public-surface.test.ts`
- Modify: `apps/worker/src/engine/scanners/url-scanner.ts`
- Modify: `apps/worker/src/engine/scanners/url-scanner.test.ts`
- Modify: `apps/web/src/app/api/scans/route.ts`
- Modify: `apps/web/src/app/api/scans/route.test.ts`
- Modify: `apps/web/src/lib/scan-presets.ts`
- Modify: `apps/web/src/lib/scan-presets.test.ts`
- Modify: `packages/types/src/url-scan-capabilities.ts`
- Modify: `packages/types/src/url-scan-capabilities.test.ts`

**Interfaces:**

- Consumes: `WEB_APP_STANDARD` profile and Safe collector.
- Produces: deterministic breadth-first same-origin discovery and a selectable Expanded Surface Review.

- [ ] **Step 1: Write failing discovery fixtures**

Create a fixture graph containing anchors, duplicate query variants, `robots.txt`, one sitemap, a cross-origin link, and more pages than the profile allows. Assert:

```ts
expect(documentUrls(result)).toEqual([
  "https://example.com/",
  "https://example.com/about",
  "https://example.com/account",
  "https://example.com/docs",
])
expect(documentUrls(result)).not.toContain("https://outside.example/path")
expect(result.subjects.filter((s) => s.kind === "document").length).toBeLessThanOrEqual(20)
expect(result.truncated).toBe(true)
```

Add tests for depth 2, malformed sitemap XML, private sitemap redirect, asset cap, total-byte cap, cancellation, and deterministic ordering independent of HTML link order.

- [ ] **Step 2: Run discovery tests and observe Safe-only behavior**

```bash
pnpm exec vitest run packages/security/src/public-surface.test.ts -t "Standard"
```

Expected: FAIL because only the seed and assets are collected.

- [ ] **Step 3: Add bounded breadth-first discovery**

For `STANDARD` and `DEEP` only:

```ts
type QueueEntry = { url: string; depth: number }

const queue: QueueEntry[] = [{ url: seedFinalUrl, depth: 0 }]
const seen = new Set<string>()
```

Extract same-origin anchors, robots sitemap declarations, `/sitemap.xml`, and bounded `<loc>` entries. Normalize, dedupe, sort each discovered batch, and append it to the queue. Do not fetch a subject when adding it would exceed document, asset, depth, byte, or wall-time limits; record `LIMIT_REACHED` once per exhausted limit.

Recognize same-origin source-map references in collected JS/CSS and fetch at most five within the existing asset count and byte budget. A reference without a successful fetch remains an observation; a fetched map can produce the stronger control-32 signal.

- [ ] **Step 4: Enable Standard only after implementation tests pass**

Add `WEB_APP_STANDARD` to `RELEASED_URL_PROFILE_IDS`, then update API availability and UI options so it becomes selectable as “Expanded Surface Review.” Keep `WEB_APP_DEEP` unavailable.

The option description must state: “Up to 20 same-origin pages and 30 client assets; passive GET requests only.”

- [ ] **Step 5: Verify Standard**

```bash
pnpm exec vitest run packages/security/src/public-surface.test.ts packages/security/src/public-surface-analysis.test.ts apps/worker/src/engine/scanners/url-scanner.test.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.test.ts
pnpm --filter @lyrashield/security lint
pnpm --filter @lyrashield/security typecheck
pnpm --filter @lyrashield/worker typecheck
```

Expected: Standard limits and availability pass; Deep remains unavailable.

- [ ] **Step 6: Commit Standard web mode**

```bash
git add packages/security/src/public-surface.ts packages/security/src/public-surface.test.ts apps/worker/src/engine/scanners/url-scanner.ts apps/worker/src/engine/scanners/url-scanner.test.ts apps/web/src/app/api/scans/route.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.ts apps/web/src/lib/scan-presets.test.ts packages/types/src/url-scan-capabilities.ts packages/types/src/url-scan-capabilities.test.ts
git commit -m "feat(scans): add bounded web surface discovery"
```

---

### Task 6: Implement Deep web behavior probes

**Files:**

- Create: `apps/worker/src/engine/scanners/url-behavior-probes.ts`
- Create: `apps/worker/src/engine/scanners/url-behavior-probes.test.ts`
- Modify: `packages/security/src/safe-fetch.ts`
- Modify: `packages/security/src/safe-fetch.test.ts`
- Modify: `apps/worker/src/engine/scanners/url-scanner.ts`
- Modify: `apps/worker/src/engine/scanners/url-scanner.test.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.test.ts`
- Modify: `apps/web/src/app/api/scans/route.ts`
- Modify: `apps/web/src/app/api/scans/route.test.ts`
- Modify: `apps/web/src/lib/scan-presets.ts`
- Modify: `apps/web/src/lib/scan-presets.test.ts`
- Modify: `packages/types/src/url-scan-capabilities.ts`
- Modify: `packages/types/src/url-scan-capabilities.test.ts`

**Interfaces:**

- Consumes: Deep collection subjects and the same SSRF-safe fetch implementation.
- Produces: `runUrlBehaviorProbes(options): Promise<{ signals; subjects; issues }>` and a selectable Behavioral Surface Review.

- [ ] **Step 1: Write failing method and CORS tests**

Tests must prove the hard allowlist:

```ts
expect(new Set(recordedRequests.map((request) => request.method))).toEqual(
  new Set(["HEAD", "OPTIONS", "GET"])
)
expect(recordedRequests).not.toEqual(
  expect.arrayContaining([expect.objectContaining({ method: "POST" })])
)
```

Add CORS cases:

```ts
it("detects reflected origin with credentials", async () => {
  const result = await runUrlBehaviorProbes(reflectingFixture)
  expect(result.signals).toContainEqual(
    expect.objectContaining({
      id: expect.stringContaining("surface.cors-reflected-credentials"),
      controlIds: [14],
      state: "DETECTED",
    })
  )
})

it("does not claim wildcard plus credentials is a successful credentialed read", async () => {
  const result = await runUrlBehaviorProbes(wildcardFixture)
  expect(result.signals.some((signal) => signal.id.includes("cors-reflected-credentials"))).toBe(
    false
  )
})
```

Also test the 20 method-probe cap, 10 origin-probe cap, no cookie replay, same-origin enforcement, cancellation, and partial issues.

- [ ] **Step 2: Run the tests and observe the missing module**

```bash
pnpm exec vitest run apps/worker/src/engine/scanners/url-behavior-probes.test.ts
```

Expected: FAIL because the probe module is absent.

- [ ] **Step 3: Implement safe behavior probes**

Export:

```ts
export async function runUrlBehaviorProbes(options: {
  collection: SurfaceCollection
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<{
  signals: SurfaceSignal[]
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
}>
```

First extend `SafeFetchOptions` with only the request controls these modes need:

```ts
export type SafeFetchMethod = "GET" | "HEAD" | "OPTIONS"

export interface SafeFetchOptions {
  // existing options remain unchanged
  method?: SafeFetchMethod
  origin?: string
  accept?: string
}
```

`safeFetchOnce()` must use `method ?? "GET"` and construct request headers from `User-Agent` plus the optional `Origin` and `Accept` values. Do not accept an arbitrary headers record: callers must not be able to inject `Cookie`, `Authorization`, `Host`, or forwarding headers. Add tests proving GET remains the default, all three allowed methods reach `fetchFn`, redirects preserve the selected safe method, and the options type has no path for a state-changing method.

Then select document/API-like subjects by normalized URL, sort them, and apply the profile caps. Use `safeFetchDetailed` with those narrow controls. Never pass response cookies into a later request.

Use `Origin: https://lyrashield.invalid` for alternate-origin GET probes. Record exact allowed-origin/credentials/Vary header evidence without response bodies.

- [ ] **Step 4: Integrate and enable Web Deep**

Run probes only when `profile.id === "WEB_APP_DEEP"`. Merge probe signals before the worker finding adapter. Add method and origin probe counts to `UrlExecutionSummary`.

After the focused tests pass, add `WEB_APP_DEEP` to `RELEASED_URL_PROFILE_IDS` and enable the dashboard/API option “Behavioral Surface Review” with the description: “Expanded review plus bounded HEAD, OPTIONS, and CORS behavior checks; no state-changing requests.”

- [ ] **Step 5: Verify Deep**

```bash
pnpm exec vitest run apps/worker/src/engine/scanners/url-behavior-probes.test.ts apps/worker/src/engine/scanners/url-scanner.test.ts apps/worker/src/engine/scanner-orchestrator.test.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.test.ts packages/security/src/safe-fetch.test.ts
pnpm --filter @lyrashield/worker lint
pnpm --filter @lyrashield/worker typecheck
```

Expected: all pass; request logs contain only GET/HEAD/OPTIONS.

- [ ] **Step 6: Commit Deep web mode**

```bash
git add apps/worker/src/engine/scanners/url-behavior-probes.ts apps/worker/src/engine/scanners/url-behavior-probes.test.ts apps/worker/src/engine/scanners/url-scanner.ts apps/worker/src/engine/scanners/url-scanner.test.ts apps/worker/src/engine/scanner-orchestrator.ts apps/worker/src/engine/scanner-orchestrator.test.ts apps/web/src/app/api/scans/route.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.ts apps/web/src/lib/scan-presets.test.ts packages/security/src/safe-fetch.ts packages/security/src/safe-fetch.test.ts packages/types/src/url-scan-capabilities.ts packages/types/src/url-scan-capabilities.test.ts
git commit -m "feat(scans): add non-mutating web behavior review"
```

---

### Task 7: Add API OpenAPI URL configuration

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260810000000_add_target_api_spec_url/migration.sql`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/index.test.ts`
- Modify: `apps/web/src/app/api/targets/route.ts`
- Create: `apps/web/src/app/api/targets/[id]/route.ts`
- Create: `apps/web/src/app/api/targets/[id]/route.test.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/targets/targets-client.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/targets/[id]/api-spec-settings.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/targets/[id]/page.tsx`

**Interfaces:**

- Consumes: target RBAC, `checkScanUrlSafe`, and API target creation.
- Produces: nullable `Target.apiSpecUrl`, create/update validation, audit records, and target UI.

- [ ] **Step 1: Write failing schema and route tests**

Add type tests proving:

```ts
expect(
  CreateUrlTargetSchema.safeParse({
    ...apiTarget,
    apiSpecUrl: "https://api.example.com/openapi.yaml",
  }).success
).toBe(true)
expect(
  CreateUrlTargetSchema.safeParse({ ...webTarget, apiSpecUrl: "https://example.com/openapi.yaml" })
    .success
).toBe(false)
```

Add route tests proving API-spec updates require `target:update`, stay in the workspace, reject private/unresolvable/spec URLs with query strings, and create `target.api_spec_updated` audit records.

- [ ] **Step 2: Add the nullable column and migration**

Prisma field:

```prisma
apiSpecUrl String?
```

Migration:

```sql
ALTER TABLE "Target" ADD COLUMN "apiSpecUrl" TEXT;

UPDATE "Schedule" AS schedule
SET "enabled" = FALSE,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE schedule."enabled" = TRUE
  AND schedule."mode" IN ('STANDARD', 'DEEP')
  AND EXISTS (
    SELECT 1
    FROM "Target" AS target
    WHERE target."id" = schedule."targetId"
      AND target."type" IN ('WEB_APP', 'API')
  );
```

Do not backfill historical targets. The update deliberately disables pre-existing recurring URL scans whose stored label did not correspond to the new execution contract. Users must explicitly re-enable them after reviewing the new capability and, for API Contract modes, configuring a spec.

- [ ] **Step 3: Implement API-only create/update validation**

Extend `CreateUrlTargetSchema` with optional `apiSpecUrl` and a `superRefine` that rejects it unless `type === "API"`. In both create and PATCH routes, call `checkScanUrlSafe()` for the target URL and OpenAPI URL independently.

PATCH body:

```ts
const PatchApiSpecSchema = z.object({
  workspaceId: z.string().min(1),
  apiSpecUrl: z.url().nullable(),
})
```

Allow null to remove the contract. Return only `id`, `type`, and `apiSpecUrl`.

- [ ] **Step 4: Add accessible target UI**

Show the OpenAPI URL field only when creating an API target. On API target detail, render `ApiSpecSettings` with:

- current URL or “No OpenAPI document configured”;
- URL input using `type="url"`;
- Save and Remove actions;
- an explanation that Standard/Deep remain unavailable without it;
- `aria-live="polite"` success and `role="alert"` failure messages.

- [ ] **Step 5: Generate Prisma and verify**

```bash
pnpm db:generate
pnpm --filter @lyrashield/db exec prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema ./prisma/schema.prisma \
  --exit-code
pnpm --filter @lyrashield/db migrate:deploy
pnpm exec vitest run packages/types/src/index.test.ts apps/web/src/app/api/targets/'[id]'/route.test.ts
pnpm --filter @lyrashield/db typecheck
pnpm --filter @lyrashield/web typecheck
```

Run the migration commands against a fresh disposable local Postgres instance with the repository's normal `DATABASE_URL`, `DATABASE_DIRECT_URL`, and shadow-database configuration. Expected: drift check exits 0, all migrations apply once, a second `migrate:deploy` is a no-op, and API/UI tests and types pass. Never point this verification at production.

- [ ] **Step 6: Commit API target configuration**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260810000000_add_target_api_spec_url/migration.sql packages/types/src/index.ts packages/types/src/index.test.ts apps/web/src/app/api/targets/route.ts apps/web/src/app/api/targets/'[id]'/route.ts apps/web/src/app/api/targets/'[id]'/route.test.ts apps/web/src/app/'(dashboard)'/dashboard/targets/targets-client.tsx apps/web/src/app/'(dashboard)'/dashboard/targets/'[id]'/api-spec-settings.tsx apps/web/src/app/'(dashboard)'/dashboard/targets/'[id]'/page.tsx
git commit -m "feat(targets): configure API OpenAPI documents"
```

---

### Task 8: Implement API Contract and Contract Behavior modes

**Files:**

- Create: `apps/worker/src/engine/scanners/openapi-scanner.ts`
- Create: `apps/worker/src/engine/scanners/openapi-scanner.test.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.test.ts`
- Modify: `apps/worker/src/engine/result-integrity.ts`
- Modify: `apps/worker/src/engine/result-integrity.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/src/app/api/scans/route.ts`
- Modify: `apps/web/src/app/api/scans/route.test.ts`
- Modify: `apps/web/src/lib/scan-presets.ts`
- Modify: `apps/web/src/lib/scan-presets.test.ts`
- Modify: `packages/types/src/url-scan-capabilities.ts`
- Modify: `packages/types/src/url-scan-capabilities.test.ts`

**Interfaces:**

- Consumes: `Target.apiSpecUrl`, API Standard/Deep profiles, `safeFetchDetailed`, and behavior probes.
- Produces: `scanOpenApi(options): Promise<OpenApiScannerResult>` and selectable API Contract modes.

- [ ] **Step 1: Add the direct YAML dependency**

Run:

```bash
pnpm --filter @lyrashield/worker add yaml@^2.7.1
```

Expected: only `apps/worker/package.json` and `pnpm-lock.yaml` dependency sections change.

- [ ] **Step 2: Write failing OpenAPI fixtures**

Fixtures must cover JSON and YAML, more than 500 paths, external `$ref`, off-origin servers, required auth, required parameters with/without examples, sensitive parameter names, header/cookie parameters, unsafe methods, parameter-free GET, documented status/content type, malformed responses, response truncation, and limits.

Core assertions:

```ts
expect(result.attemptedOperations.map((operation) => operation.method)).toEqual(["GET", "HEAD"])
expect(result.attemptedOperations).toHaveLength(10)
expect(result.issues).toContainEqual(
  expect.objectContaining({ code: "AUTHENTICATION_REQUIRED", subject: "GET /private" })
)
expect(fetchFn).not.toHaveBeenCalledWith(
  expect.stringContaining("outside.example"),
  expect.anything()
)
```

For Deep, prove at most 25 GET/HEAD/OPTIONS operations and that POST/PUT/PATCH/DELETE operations never reach `fetchFn`.

- [ ] **Step 3: Run tests and observe the missing scanner**

```bash
pnpm exec vitest run apps/worker/src/engine/scanners/openapi-scanner.test.ts
```

Expected: FAIL because `openapi-scanner.ts` is absent.

- [ ] **Step 4: Implement bounded parsing and operation planning**

Export:

```ts
export type OpenApiScannerResult = {
  findings: EngineVulnerability[]
  signals: SurfaceSignal[]
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  attemptedOperations: Array<{ method: "GET" | "HEAD" | "OPTIONS"; path: string; url: string }>
}

export async function scanOpenApi(options: {
  targetUrl: string
  apiSpecUrl: string
  profile: UrlScanProfile
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<OpenApiScannerResult>
```

Parse JSON first and YAML second. Reject non-object documents, non-3.x versions, or more than 500 paths as `UNSUPPORTED_CONTENT`. Resolve local JSON Pointers only. Never fetch a `$ref`.

Resolve servers and operation paths against the target's final origin. Select safe operations in sorted path/method order. For Standard, execute only parameter-free unauthenticated GET/HEAD operations. For Deep, fill path/query values from documented examples/defaults/enum and add OPTIONS/CORS probes. Percent-encode every value and recheck the completed URL's exact origin. Never populate header/cookie parameters or authentication-/secret-like names, and never place built query values in logs, evidence, or issues. Skip everything else with an issue.

The 2 MiB spec response consumes the profile's total-byte and wall-time budgets. Apply `maxResponseBytes`, `maxTotalBytes`, `maxConcurrency`, `maxWallTimeMs`, `maxOperations`, and `maxOriginProbes` from the profile; do not introduce a second set of OpenAPI constants except the 500-path parser ceiling.

Validate declared status and content type. For inline JSON schemas, compare top-level `type`, `required`, and primitive property types. Record unsupported compositions as `SCHEMA_UNSUPPORTED` rather than treating them as success.

- [ ] **Step 5: Integrate coverage and enable API modes**

Pass `apiSpecUrl` through `run-scan.job.ts` and the orchestrator. Run OpenAPI scanning only for `API_STANDARD` or `API_DEEP`. Map contract findings to relevant controls only when evidence is explicit; unmatched API controls remain inconclusive.

After worker and API tests pass, add `API_STANDARD` and `API_DEEP` to `RELEASED_URL_PROFILE_IDS`. Enable:

- Standard “Contract Review” only when `apiSpecUrl` exists.
- Deep “Contract Behavior Review” only when `apiSpecUrl` exists.

If a caller removes the spec after creating a schedule, admission fails with `API_SPEC_REQUIRED`; no silent Safe fallback.

- [ ] **Step 6: Verify API modes**

```bash
pnpm exec vitest run apps/worker/src/engine/scanners/openapi-scanner.test.ts apps/worker/src/engine/scanner-orchestrator.test.ts apps/worker/src/engine/result-integrity.test.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.test.ts
pnpm --filter @lyrashield/worker lint
pnpm --filter @lyrashield/worker typecheck
pnpm --filter @lyrashield/web typecheck
```

Expected: JSON/YAML and all method/scope limits pass; API modes are capability-gated.

- [ ] **Step 7: Commit API modes**

```bash
git add apps/worker/src/engine/scanners/openapi-scanner.ts apps/worker/src/engine/scanners/openapi-scanner.test.ts apps/worker/src/engine/scanner-orchestrator.ts apps/worker/src/engine/scanner-orchestrator.test.ts apps/worker/src/engine/result-integrity.ts apps/worker/src/engine/result-integrity.test.ts apps/worker/package.json pnpm-lock.yaml apps/web/src/app/api/scans/route.ts apps/web/src/app/api/scans/route.test.ts apps/web/src/lib/scan-presets.ts apps/web/src/lib/scan-presets.test.ts packages/types/src/url-scan-capabilities.ts packages/types/src/url-scan-capabilities.test.ts
git commit -m "feat(scans): add OpenAPI contract review modes"
```

---

### Task 9: Persist and render exact URL execution scope

**Files:**

- Modify: `apps/worker/src/engine/result-integrity.ts`
- Modify: `apps/worker/src/engine/result-integrity.test.ts`
- Modify: `apps/worker/src/jobs/run-scan.job.ts`
- Modify: `apps/worker/src/jobs/run-scan.job.test.ts`
- Modify: `packages/db/src/report-generator.ts`
- Modify: `packages/db/src/report-generator.test.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/scans/[id]/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client.tsx`

**Interfaces:**

- Consumes: URL/web/OpenAPI execution summaries and collection issues.
- Produces: immutable `urlExecution` manifest metadata, scoped receipts, report text, and dashboard coverage summaries.

- [ ] **Step 1: Write failing manifest tests**

Assert the manifest stores bounded aggregate data:

```ts
expect(manifest.urlExecution).toEqual({
  contractVersion: "url-scan/2.0.0",
  profile: "WEB_APP_STANDARD",
  methods: ["GET"],
  subjectCount: 17,
  documentCount: 10,
  assetCount: 7,
  operationCount: 0,
  methodProbeCount: 0,
  originProbeCount: 0,
  totalBytes: 2048,
  truncated: true,
  issueCodes: ["LIMIT_REACHED"],
})
expect(JSON.stringify(manifest)).not.toContain("<html")
expect(JSON.stringify(manifest)).not.toContain("token=")
```

Add receipt tests proving failed subjects, auth-required operations, unavailable parameter values, and limit exhaustion prevent broad `NO_FINDING` claims.

- [ ] **Step 2: Implement manifest and receipt propagation**

Add nullable `urlExecution` to `ResultManifestInput`. Store sorted unique methods and issue codes. Count subjects by kind. Do not store response bodies or full response headers.

The URL family receipt is `COMPLETED` only when the seed was fetched. Individual deterministic control receipts may be `NO_FINDING` only for methods and subjects actually covered; collection issues add explicit limitations.

- [ ] **Step 3: Render scope in reports and scan detail**

Display:

```text
Expanded Surface Review · 10 pages · 7 assets · GET only
Coverage limited: document limit reached
```

For API Deep:

```text
Contract Behavior Review · 25 operations · GET, HEAD, OPTIONS
Not tested: 4 authenticated operations; 3 operations lacked documented parameter values
```

Always include: “This public, non-mutating review did not authenticate or validate exploitability.”

Use four summary groups: Needs attention, No issue found in stated scope, Needs evidence, and Not assessed.

- [ ] **Step 4: Verify persistence and presentation**

```bash
pnpm exec vitest run apps/worker/src/engine/result-integrity.test.ts apps/worker/src/jobs/run-scan.job.test.ts packages/db/src/report-generator.test.ts
pnpm --filter @lyrashield/db typecheck
pnpm --filter @lyrashield/web typecheck
```

Expected: aggregate-only manifests and scoped UI/report text pass.

- [ ] **Step 5: Commit exact scope reporting**

```bash
git add apps/worker/src/engine/result-integrity.ts apps/worker/src/engine/result-integrity.test.ts apps/worker/src/jobs/run-scan.job.ts apps/worker/src/jobs/run-scan.job.test.ts packages/db/src/report-generator.ts packages/db/src/report-generator.test.ts apps/web/src/app/'(dashboard)'/dashboard/scans/'[id]'/page.tsx apps/web/src/app/'(dashboard)'/dashboard/scans/'[id]'/scan-detail-client.tsx
git commit -m "feat(reports): expose URL scan scope and limitations"
```

---

### Task 10: Enforce target-aware schedules and complete UX

**Files:**

- Modify: `apps/web/src/app/api/schedules/route.ts`
- Modify: `apps/web/src/app/api/schedules/[id]/route.ts`
- Create: `apps/web/src/app/api/schedules/route.test.ts`
- Create: `apps/web/src/app/api/schedules/[id]/route.test.ts`
- Modify: `apps/web/src/app/api/findings/[id]/retests/route.ts`
- Modify: `apps/web/src/app/api/findings/[id]/retests/route.test.ts`
- Modify: `apps/worker/src/schedules.ts`
- Modify: `apps/worker/src/schedules.test.ts`
- Modify: `packages/db/src/schedule-service.ts`
- Modify: `packages/db/src/schedule-service.test.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/schedules/schedules-client.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/scans/scans-client.tsx`
- Modify: `apps/web/src/lib/api-schemas.ts`

**Interfaces:**

- Consumes: profile registry and target `apiSpecUrl` state.
- Produces: server-enforced manual/scheduled mode parity and responsive, accessible target-aware selection.

- [ ] **Step 1: Write failing schedule admission tests**

Prove:

```ts
it("rejects API Contract schedules without a spec", async () => {
  prisma.target.findFirst.mockResolvedValue({ ...apiTarget, apiSpecUrl: null })
  const response = await POST(scheduleRequest({ mode: "STANDARD" }))
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: "API_SPEC_REQUIRED" } })
})
```

Also test schedule updates, deleted targets, cross-workspace targets, Web Standard/Deep acceptance, and the legacy `QUICK` alias.

- [ ] **Step 2: Centralize server-side target/mode enforcement**

Add the pure helper to `packages/types/src/url-scan-capabilities.ts` and test it in `packages/types/src/url-scan-capabilities.test.ts`. Call it only after the route or worker has loaded the authorized target:

```ts
export function resolveTargetScanMode(input: {
  targetType: string
  mode: string
  hasApiSpec: boolean
}):
  | { ok: true; profile: UrlScanProfile | null }
  | {
      ok: false
      code: Exclude<UrlModeAvailability, { available: true }>["code"]
      reason: string
    }
```

Return `{ ok: true, profile: null }` for repository targets and the resolved profile for available web/API modes. Return a typed unavailable result instead of throwing for expected input. Manual scans, schedules, schedule updates, retests, and agent/MCP scan creation must all route through this helper or an equivalent service boundary.

`/api/v1/scans` re-exports `/api/scans`, and the MCP tools call that v1 endpoint, so the manual API guard covers those clients without a second implementation. Add a route test proving the shared handler behavior, not duplicate MCP mode logic.

Before a due schedule creates a scan, `apps/worker/src/schedules.ts` must resolve the current target and re-run the same pure check. If a spec was removed or the mode is no longer available, disable that schedule, log only its IDs and typed reason, and do not create or enqueue a scan. Retests must load the current target before creating the replacement scan and return `API_SPEC_REQUIRED` or `URL_MODE_UNSUPPORTED` rather than silently falling back to Safe.

- [ ] **Step 3: Finish target-aware responsive UX**

Manual scans:

- show three repository options for repositories;
- show three web options after Tasks 5–6;
- show API Safe plus locked Standard/Deep guidance until an OpenAPI URL exists;
- reset an invalid selected mode to Safe when target type changes;
- announce the mode reset with `aria-live="polite"`;
- keep arrow-key radio navigation within available options.

Schedules use the same names and requirements. At 390 px, cards stack without horizontal overflow and the primary action remains visible after the options.

- [ ] **Step 4: Verify all admission paths**

```bash
pnpm exec vitest run apps/web/src/app/api/scans/route.test.ts apps/web/src/app/api/schedules/route.test.ts apps/web/src/app/api/schedules/'[id]'/route.test.ts apps/web/src/app/api/findings/'[id]'/retests/route.test.ts apps/worker/src/schedules.test.ts packages/types/src/url-scan-capabilities.test.ts packages/db/src/schedule-service.test.ts apps/web/src/lib/scan-presets.test.ts
pnpm --filter @lyrashield/web lint
pnpm --filter @lyrashield/web typecheck
```

Expected: UI and every server admission path agree on availability.

- [ ] **Step 5: Commit admission and UX parity**

```bash
git add apps/web/src/app/api/schedules apps/web/src/app/api/findings/'[id]'/retests/route.ts apps/web/src/app/api/findings/'[id]'/retests/route.test.ts apps/web/src/app/'(dashboard)'/dashboard/schedules/schedules-client.tsx apps/web/src/app/'(dashboard)'/dashboard/scans/scans-client.tsx apps/web/src/lib/api-schemas.ts apps/web/src/lib/scan-presets.ts apps/worker/src/schedules.ts apps/worker/src/schedules.test.ts packages/types/src/url-scan-capabilities.ts packages/types/src/url-scan-capabilities.test.ts packages/db/src/schedule-service.ts packages/db/src/schedule-service.test.ts
git commit -m "feat(scans): align URL modes across scans and schedules"
```

---

### Task 11: Reconcile documentation and public claims

**Files:**

- Modify: `AGENTS.md`
- Modify: `PRD.md`
- Modify: `codebase.md`
- Modify: `userguide.md`
- Modify: `docs/vibe-security-50.md`
- Modify: `apps/marketing/src/pages/scan.astro`
- Modify: `apps/marketing/src/pages/methodology.astro`
- Modify: `apps/marketing/src/pages/vibe-security-50.astro`
- Modify: `apps/marketing/src/tests/lite-scan.test.ts`
- Modify: `apps/marketing/src/tests/seo.test.ts`

**Interfaces:**

- Consumes: completed mode behavior and release-gate evidence.
- Produces: one consistent public/operator explanation with no stale CORS or full-scan claims.

- [ ] **Step 1: Write claim-regression assertions**

Add assertions that public copy contains “passive,” “outside-only,” and “no authenticated testing,” and does not contain:

```ts
const forbidden = [
  "43 machine-testable vulnerabilities",
  "full URL pentest",
  "all endpoints tested",
  "CORS tested", // allowed only after Deep is live and explicitly qualified
]
```

When Deep ships in the same release, replace the final forbidden string with an assertion requiring “controlled CORS checks in Behavioral Surface Review.”

- [ ] **Step 2: Update sources of truth**

Document the exact mode tables from the design, request limits, OpenAPI requirement, engine exclusion, and evidence semantics. Replace historical “10 URL detectors” descriptions in current-state sections with the new shared analyzer. Keep dated historical sections explicitly labeled historical rather than rewriting release history.

- [ ] **Step 3: Verify docs and marketing**

```bash
pnpm test:marketing
pnpm --filter @lyrashield/marketing blog:validate
pnpm --filter @lyrashield/marketing compare:validate
pnpm --filter @lyrashield/marketing build
rg -n "43 machine-testable|full URL pentest|all endpoints tested" AGENTS.md PRD.md codebase.md userguide.md docs apps packages
```

Expected: tests/build pass and `rg` returns no current-state overclaim.

- [ ] **Step 4: Commit documentation**

```bash
git add AGENTS.md PRD.md codebase.md userguide.md docs/vibe-security-50.md apps/marketing/src/pages/scan.astro apps/marketing/src/pages/methodology.astro apps/marketing/src/pages/vibe-security-50.astro apps/marketing/src/tests/lite-scan.test.ts apps/marketing/src/tests/seo.test.ts
git commit -m "docs(scans): document target-specific URL review modes"
```

---

### Task 12: Run release verification and rendered QA

**Files:**

- Verify: all changed files
- Do not create deployment configuration or production mutations

**Interfaces:**

- Consumes: Tasks 0–11.
- Produces: local evidence that the branch is ready for review, with explicit unverified production state.

- [ ] **Step 1: Run focused security and worker suites**

```bash
pnpm exec vitest run \
  packages/types/src/url-scan-capabilities.test.ts \
  packages/types/src/index.test.ts \
  packages/security/src/public-surface.test.ts \
  packages/security/src/public-surface-analysis.test.ts \
  packages/security/src/lite-scan.test.ts \
  packages/security/src/safe-fetch.test.ts \
  packages/security/src/ssrf.test.ts \
  apps/worker/src/engine/scanners/url-scanner.test.ts \
  apps/worker/src/engine/scanners/url-behavior-probes.test.ts \
  apps/worker/src/engine/scanners/openapi-scanner.test.ts \
  apps/worker/src/engine/scanner-orchestrator.test.ts \
  apps/worker/src/engine/result-integrity.test.ts \
  apps/worker/src/jobs/run-scan.job.test.ts \
  apps/web/src/app/api/scans/route.test.ts \
  packages/db/src/report-generator.test.ts
```

Expected: all pass with no network access beyond injected test fixtures.

- [ ] **Step 2: Run package and repository gates**

```bash
pnpm db:generate
pnpm --filter @lyrashield/db exec prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema ./prisma/schema.prisma \
  --exit-code
pnpm --filter @lyrashield/db migrate:deploy
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
pnpm test:marketing
pnpm test:motion
pnpm build
git diff --check
```

Run the migration commands against a fresh disposable local Postgres instance, not production. Expected: every command exits 0. Record exact test counts in the handoff; do not reuse counts from `AGENTS.md`.

- [ ] **Step 3: Build and inspect the actual dashboard**

Start the local stack using the repository-supported environment. Verify with the in-app browser:

1. Repository target still shows the original three repository modes.
2. Web target shows Surface, Expanded Surface, and Behavioral Surface Review.
3. API target without a spec allows only Endpoint Review and links to target settings.
4. Adding an OpenAPI URL unlocks Contract and Contract Behavior Review.
5. Switching target types resets an invalid mode and announces it.
6. Mode details state exact request/page/operation limits.
7. Scan detail renders methods, subjects, truncation, and inconclusive reasons.
8. Desktop 1440×1000 and mobile 390×844 have no horizontal overflow.
9. Reduced-motion mode does not prevent progress or result rendering.

Do not start a provider-backed repository engine run. Use route fixtures or an approved inert local HTTP fixture for scan-result rendering.

- [ ] **Step 4: Inspect the final diff**

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD --check
git log --oneline main..HEAD
```

Expected: only URL/API scan-mode, Vibe integrity baseline, tests, migration, and documentation changes are present.

- [ ] **Step 5: Commit any verification-only fixture correction**

If rendered QA required a focused fixture or accessibility correction, stage only those exact files and commit:

```bash
git commit -m "test(scans): cover URL mode release flows"
```

If no file changed, skip this commit.

---

## Acceptance criteria

- The public Lite Check and authenticated Safe web scan share one collector and analyzer.
- URL/API mode selection is target-aware and backend-enforced.
- Safe, Standard, and Deep perform observably different work.
- Standard web scans collect no more than 20 documents and 30 assets at depth 2.
- Deep web scans use only GET, HEAD, and OPTIONS and respect all request/byte limits.
- API Standard/Deep require a stored, SSRF-safe OpenAPI URL.
- No API state-changing operation can reach the fetch boundary.
- No raw body or matched credential is persisted or logged.
- URL scans emit no model-budget event and never call the external engine.
- Every limitation is retained in the immutable manifest and visible in reports.
- Unattempted, authenticated, unsupported, or parameter-incomplete API operations are inconclusive.
- Repository scan behavior and model routing are unchanged.
- Marketing and user documentation match the actual released modes.
- Focused tests, full tests, lint, typecheck, format, build, migration generation, and rendered desktop/mobile QA pass.

## Deferred project boundary

Authenticated web/API testing and model-assisted URL review are deliberately excluded. Start that work only after a separate design defines credential-vault storage, revocation, per-request secret retrieval, audit redaction, test-account lifecycle, engine egress enforcement, and an approved evaluation corpus.
