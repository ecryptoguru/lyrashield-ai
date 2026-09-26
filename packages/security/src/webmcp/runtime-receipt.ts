/**
 * WebMCP runtime-check receipt contract.
 *
 * A runtime receipt records what the opt-in runtime checker
 * (`scripts/webmcp-runtime-check.mjs`) observed while exercising
 * customer-controlled WebMCP fixture pages inside one browser profile. It is
 * deliberately separate from the static analyzer's findings: static
 * detections describe source shape, runtime observations describe what a
 * specific browser did against a specific fixture set.
 *
 * This module is the pure contract — browser-safe and free of Node builtins
 * so it can be imported by the runner, by web surfaces, or by tests. Trust
 * boundary: a receipt produced elsewhere is untrusted external evidence;
 * validate it through {@link validateWebMcpRuntimeReceipt} before use.
 *
 * Honesty rules enforced here and by the runner:
 *
 * - `state: "PASS"` may only attest a check that actually executed against
 *   the real `document.modelContext` API on the named browser. When the
 *   native API is absent (stock Chromium today), native-dependent checks
 *   record `INCONCLUSIVE` — a JS shim never produces a native-browser PASS.
 * - `target.origin` stores only the canonical origin. Userinfo is rejected
 *   (never silently stripped — credentials must not transit a receipt), and
 *   query/fragment/path are dropped. Cookies, tokens, raw page source, and
 *   tool input/output bodies are never stored.
 * - Receipt identity is optional but marked: `revision`/`contentChecksum`
 *   bind the checked content; a receipt without either carries the
 *   `webmcp.target-identity` check at `INCONCLUSIVE`.
 */

import { z } from "zod"

export const WEBMCP_RUNTIME_RECEIPT_VERSION = "lyrashield-webmcp-runtime/1" as const

export const WEBMCP_RUNTIME_CHECK_STATES = [
  "PASS",
  "FAIL",
  "INCONCLUSIVE",
  "NOT_APPLICABLE",
] as const
export type WebMcpRuntimeCheckState = (typeof WEBMCP_RUNTIME_CHECK_STATES)[number]

/**
 * Evidence method vocabulary. `"native-browser"` is the only method today: a
 * check attested by observation of a real browser's native WebMCP surface.
 * Shim-based or static-derived observations must never be labeled this way.
 */
export const WEBMCP_RUNTIME_CHECK_METHODS = ["native-browser"] as const
export type WebMcpRuntimeCheckMethod = (typeof WEBMCP_RUNTIME_CHECK_METHODS)[number]

/** Well-known check ids emitted by the runtime runner. */
export const WEBMCP_RUNTIME_CHECK_IDS = {
  /** Binds the receipt to fixture content identity (revision/checksum). */
  targetIdentity: "webmcp.target-identity",
  /** The fixture page loaded inside the declared-origin boundary. */
  fixtureLoad: "webmcp.fixture-load",
  /** Every request/redirect stayed inside declared origins. */
  declaredOrigins: "webmcp.declared-origins",
  /** The native `document.modelContext` API is present in this browser. */
  nativeApi: "webmcp.native-api",
  /** Registered tools/contracts enumerated without executing them. */
  toolEnumeration: "webmcp.tool-enumeration",
  /** Passive observation executed no tool (instrumentation stayed empty). */
  passiveNoExecution: "webmcp.passive-no-execution",
  /** Explicitly allowlisted active tool execution; id is suffixed `:name`. */
  toolExecution: "webmcp.tool-execution",
} as const

export interface WebMcpRuntimeCheck {
  id: string
  state: WebMcpRuntimeCheckState
  method: WebMcpRuntimeCheckMethod
  summary: string
}

export interface WebMcpRuntimeReceipt {
  schemaVersion: typeof WEBMCP_RUNTIME_RECEIPT_VERSION
  runId: string
  checkedAt: string
  browser: { name: string; version: string; nativeApiAvailable: boolean }
  target: { origin: string; revision?: string; contentChecksum?: string }
  checks: WebMcpRuntimeCheck[]
  limits: { timedOut: boolean; skipped: string[] }
}

// ---------------------------------------------------------------------------
// Origin sanitization — the only representation of a target allowed in a
// receipt or allowlist entry is the canonical `scheme://host[:port]` origin.
// ---------------------------------------------------------------------------

const PAGE_ORIGIN_SCHEMES = new Set(["http:", "https:"])
const DECLARED_ORIGIN_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"])

export class WebMcpRuntimeInputError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = "WebMcpRuntimeInputError"
    this.reason = reason
  }
}

function isPrivateishHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === "localhost" ||
    host === "localhost." ||
    host.endsWith(".localhost") ||
    host.endsWith(".localhost.") ||
    // URL canonicalization folds integer/hex/shorthand IPv4 spellings into
    // dotted quad, so 127.0.0.0/8 and 0.0.0.0/8 show up as "127.*" / "0.*".
    host.startsWith("127.") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  )
}

/**
 * Normalize a URL to its canonical origin for receipt storage / allowlist
 * comparison.
 *
 * - Requires an absolute URL with an allowed scheme (http/https for page
 *   targets; `allowAnyOriginSchemes` also admits ws/wss for subresource
 *   allowlist entries).
 * - Rejects userinfo outright — never silently strips credentials.
 * - Drops path, query, and fragment entirely (they are never stored).
 * - `allowLoopback` must be opted into for loopback hosts; the runtime
 *   runner grants it only to the ephemeral fixture server origin.
 */
export function sanitizeOrigin(
  input: string,
  options: { allowLoopback?: boolean; allowAnyOriginSchemes?: boolean } = {}
): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new WebMcpRuntimeInputError("invalid_origin", "origin must be a non-empty string")
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WebMcpRuntimeInputError(
      "invalid_origin",
      `origin ${JSON.stringify(input.slice(0, 120))} is not an absolute URL`
    )
  }
  const schemes = options.allowAnyOriginSchemes ? DECLARED_ORIGIN_SCHEMES : PAGE_ORIGIN_SCHEMES
  if (!schemes.has(url.protocol)) {
    throw new WebMcpRuntimeInputError(
      "origin_scheme",
      `origin scheme ${JSON.stringify(url.protocol)} is not allowed`
    )
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebMcpRuntimeInputError(
      "origin_userinfo",
      "origin must not contain userinfo (credentials are never stored)"
    )
  }
  if (!options.allowLoopback && isPrivateishHostname(url.hostname)) {
    throw new WebMcpRuntimeInputError(
      "origin_loopback",
      `loopback origin ${JSON.stringify(url.hostname)} requires explicit opt-in`
    )
  }
  // URL.origin serialization already drops path/query/fragment, normalizes
  // scheme+host case, strips default ports, and renders IPv6 in brackets.
  if (url.origin === "null") {
    throw new WebMcpRuntimeInputError("invalid_origin", "origin could not be canonicalized")
  }
  return url.origin
}

/** True when `input` is already in canonical sanitized-origin form. */
export function isCanonicalOrigin(
  input: string,
  options: { allowLoopback?: boolean; allowAnyOriginSchemes?: boolean } = {}
): boolean {
  try {
    return sanitizeOrigin(input, options) === input
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Zod schema — the validation boundary for receipts entering or leaving the
// runner. `target.origin` must already be canonical: a stored path, query,
// fragment, or userinfo fails validation rather than being stripped after
// the fact.
// ---------------------------------------------------------------------------

const originSchema = z
  .string()
  .min(1)
  .max(300)
  .superRefine((value, ctx) => {
    try {
      if (sanitizeOrigin(value, { allowLoopback: true }) !== value) {
        ctx.addIssue({ code: "custom", message: "origin must be canonical sanitized form" })
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "origin is not a valid URL",
      })
    }
  })

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "contentChecksum must be a lowercase sha256 hex digest")

export const WebMcpRuntimeCheckSchema = z.strictObject({
  id: z.string().min(1).max(200),
  state: z.enum(WEBMCP_RUNTIME_CHECK_STATES),
  method: z.enum(WEBMCP_RUNTIME_CHECK_METHODS),
  summary: z.string().min(1).max(2000),
})

export const WebMcpRuntimeReceiptSchema = z.strictObject({
  schemaVersion: z.literal(WEBMCP_RUNTIME_RECEIPT_VERSION),
  runId: z.string().min(1).max(200),
  checkedAt: z.iso.datetime(),
  browser: z.strictObject({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(100),
    nativeApiAvailable: z.boolean(),
  }),
  target: z.strictObject({
    origin: originSchema,
    revision: z.string().min(1).max(200).optional(),
    contentChecksum: sha256HexSchema.optional(),
  }),
  checks: z.array(WebMcpRuntimeCheckSchema).max(2000),
  limits: z.strictObject({
    timedOut: z.boolean(),
    skipped: z.array(z.string().min(1).max(200)).max(500),
  }),
})

export type WebMcpRuntimeReceiptValidation =
  { ok: true; receipt: WebMcpRuntimeReceipt } | { ok: false; errors: string[] }

/**
 * Validate an untrusted receipt at an import/export boundary. Never throws;
 * returns a discriminated result so callers fail closed.
 */
export function validateWebMcpRuntimeReceipt(input: unknown): WebMcpRuntimeReceiptValidation {
  const parsed = WebMcpRuntimeReceiptSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ),
    }
  }
  return { ok: true, receipt: parsed.data as WebMcpRuntimeReceipt }
}

// ---------------------------------------------------------------------------
// Receipt construction helpers
// ---------------------------------------------------------------------------

function createRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface WebMcpRuntimeTargetInput {
  /** Absolute page URL. Only the canonical origin is stored. */
  url: string
  /** Optional source revision binding the checked content. */
  revision?: string
  /** Optional sha256 hex digest binding the checked fixture content. */
  contentChecksum?: string
}

/**
 * Create a receipt skeleton for a run. The target URL is sanitized to its
 * canonical origin (path/query/fragment dropped; userinfo rejected), and the
 * `webmcp.target-identity` check is recorded immediately so a receipt without
 * revision/checksum is marked INCONCLUSIVE rather than silently unbound.
 */
export function createRuntimeReceipt(input: {
  runId?: string
  checkedAt?: string
  browser: { name: string; version: string; nativeApiAvailable: boolean }
  target: WebMcpRuntimeTargetInput
}): WebMcpRuntimeReceipt {
  const origin = sanitizeOrigin(input.target.url, { allowLoopback: true })
  const target: WebMcpRuntimeReceipt["target"] = { origin }
  if (input.target.revision !== undefined) target.revision = input.target.revision
  if (input.target.contentChecksum !== undefined) {
    target.contentChecksum = input.target.contentChecksum
  }
  const receipt: WebMcpRuntimeReceipt = {
    schemaVersion: WEBMCP_RUNTIME_RECEIPT_VERSION,
    runId: input.runId ?? createRunId(),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    browser: { ...input.browser },
    target,
    checks: [],
    limits: { timedOut: false, skipped: [] },
  }
  appendRuntimeCheck(receipt, buildTargetIdentityCheck(receipt.target))
  return receipt
}

/** True when the receipt binds fixture content identity. */
export function hasRuntimeTargetIdentity(
  target: Pick<WebMcpRuntimeReceipt["target"], "revision" | "contentChecksum">
): boolean {
  return target.revision !== undefined || target.contentChecksum !== undefined
}

/**
 * The identity check every receipt carries: PASS when a revision or content
 * checksum binds the observation to exact fixture content, INCONCLUSIVE when
 * the receipt cannot say which content it covered.
 */
export function buildTargetIdentityCheck(
  target: Pick<WebMcpRuntimeReceipt["target"], "revision" | "contentChecksum">
): WebMcpRuntimeCheck {
  if (hasRuntimeTargetIdentity(target)) {
    const bound = [
      target.revision !== undefined ? `revision ${target.revision}` : null,
      target.contentChecksum !== undefined
        ? `content sha256:${target.contentChecksum.slice(0, 16)}…`
        : null,
    ]
      .filter(Boolean)
      .join(" + ")
    return {
      id: WEBMCP_RUNTIME_CHECK_IDS.targetIdentity,
      state: "PASS",
      method: "native-browser",
      summary: `receipt binds checked content (${bound})`,
    }
  }
  return {
    id: WEBMCP_RUNTIME_CHECK_IDS.targetIdentity,
    state: "INCONCLUSIVE",
    method: "native-browser",
    summary:
      "receipt does not bind a revision or content checksum; coverage of exact fixture content is unproven",
  }
}

/** Append one validated check entry. Throws on malformed entries. */
export function appendRuntimeCheck(
  receipt: WebMcpRuntimeReceipt,
  check: WebMcpRuntimeCheck
): WebMcpRuntimeCheck {
  const parsed = WebMcpRuntimeCheckSchema.parse(check)
  receipt.checks.push(parsed as WebMcpRuntimeCheck)
  return parsed as WebMcpRuntimeCheck
}

/** Convenience recorder for limit state (timeout / skipped check ids). */
export function recordRuntimeLimit(
  receipt: WebMcpRuntimeReceipt,
  limit: { timedOut?: boolean; skip?: string }
): void {
  if (limit.timedOut) receipt.limits.timedOut = true
  if (limit.skip !== undefined && !receipt.limits.skipped.includes(limit.skip)) {
    receipt.limits.skipped.push(limit.skip)
  }
}

/**
 * Final validation pass before a receipt leaves the runner. Throws (fail
 * closed) rather than emitting a non-conforming receipt.
 */
export function finalizeRuntimeReceipt(receipt: WebMcpRuntimeReceipt): WebMcpRuntimeReceipt {
  return WebMcpRuntimeReceiptSchema.parse(receipt) as WebMcpRuntimeReceipt
}

export type WebMcpRuntimeOverallState = "PASS" | "FAIL" | "INCONCLUSIVE" | "EMPTY"

export interface WebMcpRuntimeReceiptSummary {
  overall: WebMcpRuntimeOverallState
  counts: Record<WebMcpRuntimeCheckState, number>
}

/**
 * Overall run state: any FAIL → FAIL; else any INCONCLUSIVE/NOT_APPLICABLE →
 * INCONCLUSIVE; else PASS. EMPTY when no checks ran at all.
 */
export function summarizeRuntimeReceipt(
  receipt: WebMcpRuntimeReceipt
): WebMcpRuntimeReceiptSummary {
  const counts: Record<WebMcpRuntimeCheckState, number> = {
    PASS: 0,
    FAIL: 0,
    INCONCLUSIVE: 0,
    NOT_APPLICABLE: 0,
  }
  for (const check of receipt.checks) counts[check.state] += 1
  const overall: WebMcpRuntimeOverallState =
    receipt.checks.length === 0
      ? "EMPTY"
      : counts.FAIL > 0
        ? "FAIL"
        : counts.INCONCLUSIVE > 0 || counts.NOT_APPLICABLE > 0
          ? "INCONCLUSIVE"
          : "PASS"
  return { overall, counts }
}
