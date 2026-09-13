import { checkInstructionSafety } from "./instruction-safety"

export const VIBE_SECURITY_COVERAGE_VERSION = "vibe-security-50/1.2.0"

export type VibeCoverageStrategy = "deterministic" | "hybrid" | "engine" | "evidence"

export interface VibeSecurityControl {
  rank: number
  title: string
  strategy: VibeCoverageStrategy
  keywords: readonly string[]
}

// ponytail: one flat registry is the contract; split it only if a second consumer needs ownership metadata.
export const VIBE_SECURITY_CONTROLS: readonly VibeSecurityControl[] = [
  {
    rank: 1,
    title: "Missing database row-level security",
    strategy: "hybrid",
    keywords: ["row-level security", "row level security", "rls"],
  },
  {
    rank: 2,
    title: "IDOR / broken object-level authorization",
    strategy: "hybrid",
    keywords: ["idor", "object-level authorization", "bola"],
  },
  {
    rank: 3,
    title: "Secrets and privileged keys exposed in frontend bundles",
    strategy: "deterministic",
    keywords: ["exposed api key", "hardcoded secret", "access key", "personal access token"],
  },
  {
    rank: 4,
    title: "Client-side-only authentication",
    strategy: "engine",
    keywords: [
      "client-side authentication",
      "client side authentication",
      "localstorage authentication",
    ],
  },
  {
    rank: 5,
    title: "Missing server-side authorization",
    strategy: "engine",
    keywords: ["missing authorization", "authorization bypass", "broken access control"],
  },
  {
    rank: 6,
    title: "Cross-tenant data leakage",
    strategy: "engine",
    keywords: ["cross-tenant", "cross tenant", "tenant isolation"],
  },
  {
    rank: 7,
    title: "Unprotected admin and internal routes",
    strategy: "engine",
    keywords: ["unprotected admin", "internal route", "forced browsing"],
  },
  {
    rank: 8,
    title: "Broken JWT and session validation",
    strategy: "engine",
    keywords: ["jwt", "session validation", "token validation"],
  },
  {
    rank: 9,
    title: "Password reset and email-verification flaws",
    strategy: "engine",
    keywords: ["password reset", "email verification", "reset token"],
  },
  {
    rank: 10,
    title: "Unsafe password storage",
    strategy: "hybrid",
    keywords: ["password storage", "plaintext password", "weak password hash"],
  },
  { rank: 11, title: "SQL injection", strategy: "engine", keywords: ["sql injection", "sqli"] },
  {
    rank: 12,
    title: "Cross-site scripting",
    strategy: "engine",
    keywords: ["cross-site scripting", "cross site scripting", "xss"],
  },
  {
    rank: 13,
    title: "Missing input validation",
    strategy: "engine",
    keywords: ["input validation", "unvalidated input", "improper input validation"],
  },
  {
    rank: 14,
    title: "Permissive CORS",
    strategy: "hybrid",
    keywords: ["cors", "cross-origin"],
  },
  {
    rank: 15,
    title: "Missing CSRF protection",
    strategy: "engine",
    keywords: ["csrf", "cross-site request forgery"],
  },
  {
    rank: 16,
    title: "Server-side request forgery",
    strategy: "engine",
    keywords: ["ssrf", "server-side request forgery"],
  },
  {
    rank: 17,
    title: "Unsafe file uploads",
    strategy: "engine",
    keywords: ["unsafe file upload", "unrestricted upload", "file upload"],
  },
  {
    rank: 18,
    title: "Path traversal",
    strategy: "engine",
    keywords: ["path traversal", "directory traversal", "file inclusion"],
  },
  {
    rank: 19,
    title: "Command injection",
    strategy: "engine",
    keywords: ["command injection", "os command", "shell injection"],
  },
  {
    rank: 20,
    title: "OAuth redirect and callback mistakes",
    strategy: "hybrid",
    keywords: ["open redirect", "oauth", "callback url"],
  },
  {
    rank: 21,
    title: "Missing rate limits",
    strategy: "engine",
    keywords: ["rate limit", "unbounded requests", "resource exhaustion"],
  },
  {
    rank: 22,
    title: "Brute force and account enumeration",
    strategy: "engine",
    keywords: ["brute force", "account enumeration", "credential stuffing"],
  },
  {
    rank: 23,
    title: "Unverified Stripe webhooks",
    strategy: "engine",
    keywords: ["webhook signature", "webhook verification", "forged webhook"],
  },
  {
    rank: 24,
    title: "Payment and entitlement logic bypass",
    strategy: "engine",
    keywords: ["payment bypass", "entitlement bypass", "price manipulation"],
  },
  {
    rank: 25,
    title: "Mass assignment",
    strategy: "engine",
    keywords: ["mass assignment", "over-posting", "overposting"],
  },
  {
    rank: 26,
    title: "Replay, race, and idempotency failures",
    strategy: "engine",
    keywords: ["race condition", "replay attack", "idempotency", "double spend"],
  },
  {
    rank: 27,
    title: "Missing security headers",
    strategy: "deterministic",
    keywords: [
      "missing content-security-policy",
      "missing strict-transport-security",
      "missing x-frame-options",
      "missing x-content-type-options",
      "missing referrer-policy",
      "missing permissions-policy",
    ],
  },
  {
    rank: 28,
    title: "Insecure cookies",
    strategy: "hybrid",
    keywords: ["insecure cookie", "cookie without", "missing cookie"],
  },
  {
    rank: 29,
    title: "Weak transport security",
    strategy: "deterministic",
    keywords: ["insecure http", "weak transport", "cleartext transmission"],
  },
  {
    rank: 30,
    title: "Public-by-default apps, buckets, and databases",
    strategy: "engine",
    keywords: ["public bucket", "public database", "publicly accessible", "anonymous access"],
  },
  {
    rank: 31,
    title: "Verbose errors and debug endpoints",
    strategy: "hybrid",
    keywords: ["stack trace", "debug output", "verbose error", "debug endpoint"],
  },
  {
    rank: 32,
    title: "Source maps and build-artifact leakage",
    strategy: "hybrid",
    keywords: ["source map", "sourcemap", "build artifact"],
  },
  {
    rank: 33,
    title: "Sensitive data in logs and analytics",
    strategy: "engine",
    keywords: ["sensitive data in log", "pii in log", "token in log", "analytics leak"],
  },
  {
    rank: 34,
    title: "Missing audit trails",
    strategy: "evidence",
    keywords: ["missing audit trail", "audit logging"],
  },
  {
    rank: 35,
    title: "Missing monitoring and alerts",
    strategy: "evidence",
    keywords: ["missing monitoring", "missing alert", "security monitoring"],
  },
  {
    rank: 36,
    title: "Missing backup and recovery proof",
    strategy: "evidence",
    keywords: ["backup and recovery", "backup recovery", "restore test", "disaster recovery"],
  },
  {
    rank: 37,
    title: "Vulnerable or outdated dependencies",
    strategy: "deterministic",
    keywords: ["vulnerable dependency", "outdated dependency", "known vulnerability"],
  },
  {
    rank: 38,
    title: "Hallucinated or malicious packages",
    strategy: "hybrid",
    keywords: [
      "malicious package",
      "hallucinated package",
      "dependency confusion",
      "typosquatting",
    ],
  },
  {
    rank: 39,
    title: "Unsafe install scripts and dependency supply chain",
    strategy: "hybrid",
    keywords: ["install script", "postinstall", "supply chain"],
  },
  {
    rank: 40,
    title: "Secrets leaked through AI prompts and context",
    strategy: "engine",
    keywords: ["system prompt leakage", "prompt context leak", "secret exfiltration"],
  },
  {
    rank: 41,
    title: "Indirect prompt injection",
    strategy: "engine",
    keywords: ["indirect prompt injection", "prompt injection"],
  },
  {
    rank: 42,
    title: "Over-permissioned MCP tools",
    strategy: "engine",
    keywords: ["mcp permission", "tool abuse", "over-permissioned tool", "overprivileged tool"],
  },
  {
    rank: 43,
    title: "Missing agent sandbox and egress controls",
    strategy: "evidence",
    keywords: ["missing sandbox", "egress control", "unrestricted network access"],
  },
  {
    rank: 44,
    title: "Destructive production permissions",
    strategy: "engine",
    keywords: ["destructive permission", "production permission", "unauthorized deletion"],
  },
  {
    rank: 45,
    title: "Poisoned rules and instruction files",
    strategy: "deterministic",
    keywords: ["poisoned instruction", "malicious instruction file", "rules poisoning"],
  },
  {
    rank: 46,
    title: "AI-generated test fabrication and blind spots",
    strategy: "evidence",
    keywords: ["fabricated test", "test blind spot", "tautological test"],
  },
  {
    rank: 47,
    title: "CI/CD confused deputy",
    strategy: "hybrid",
    keywords: ["confused deputy", "pull_request_target", "workflow token"],
  },
  {
    rank: 48,
    title: "Multi-agent propagation",
    strategy: "evidence",
    keywords: ["multi-agent propagation", "subagent propagation", "agent trust chain"],
  },
  {
    rank: 49,
    title: "Placeholder logic and silent business failures",
    strategy: "engine",
    keywords: ["placeholder logic", "stub implementation", "fake success", "silent failure"],
  },
  {
    rank: 50,
    title: "No accountable human review or threat model",
    strategy: "evidence",
    keywords: ["human review", "threat model", "security owner"],
  },
]

export interface VibeCoverageFinding {
  title: string
  description?: string
  technical_analysis?: string
  control_ids?: readonly number[]
}

export function buildVibeSecurityInstruction(goal: string): string {
  const safety = checkInstructionSafety(goal)
  if (!safety.safe) {
    throw new Error(`Unsafe scan goal rejected: ${safety.reason}`)
  }
  const reviewControls = VIBE_SECURITY_CONTROLS.filter((control) => control.strategy !== "evidence")
  const evidenceControls = VIBE_SECURITY_CONTROLS.filter(
    (control) => control.strategy === "evidence"
  )
  const checklist = reviewControls
    .map((control) => `${control.rank} | ${control.strategy} | ${control.title}`)
    .join("\n")
  return [
    `Goal: ${goal}`,
    `LyraShield control version: ${VIBE_SECURITY_COVERAGE_VERSION}`,
    "Assess each applicable control below. Report only evidence-backed findings; absence of evidence is not a vulnerability.",
    "Every reported finding must include the applicable numeric ranks in control_ids.",
    checklist,
    `Controls ${evidenceControls.map((control) => control.rank).join(", ")} require separate deployment, operational, or accountable-human evidence and must not be inferred from source alone.`,
  ].join("\n")
}

/**
 * Instruction preamble for engine-backed live targets (WEB_APP/API).
 *
 * The control checklist is identical — controls are target-agnostic — but a
 * live deployment needs scope, safety, and evidence rules that a repository
 * review does not. The relay enforces these at the network layer; this text
 * keeps the model honest inside it.
 */
export function buildUrlTargetInstruction(
  goal: string,
  opts: {
    host: string
    targetType: "WEB_APP" | "API"
    environment?: string | null
    hasCredentials?: boolean
    hasApiSpec?: boolean
    /** Optional emphasis — steers attention, never reduces coverage. */
    focus?: "auth" | "payments" | "llm_surface" | "file_handling" | "data_exposure" | null
  }
): string {
  const FOCUS_HINTS: Record<string, string> = {
    auth: "Prioritize authentication and session surface: login/session flows, token handling, authorization boundaries, and account-recovery paths.",
    payments: "Prioritize payment and billing surface: checkout, refund, subscription, idempotency, and amount-handling paths.",
    llm_surface: "Prioritize LLM/agent surface: prompt surfaces, tool calls, model-controlled output rendering, and context-flow boundaries.",
    file_handling: "Prioritize file handling: upload, download, parsing, storage, and path-traversal surface.",
    data_exposure: "Prioritize data exposure: verbose errors, debug surfaces, leaked secrets in responses, and over-broad data returns.",
  }
  const base = buildVibeSecurityInstruction(goal)
  const lines = [
    base,
    "",
    "Live target posture:",
    `- Test only the verified scope: ${opts.host} and its subdomains. The relay denies anything outside it — treat denies as hard scope limits, never as retries.`,
    "- This is a deployed system: prefer non-destructive, idempotent evidence. Do not bulk-submit forms, mass-create accounts, or trigger notification storms.",
    "- Reproduce every finding and keep evidence excerpts minimal; redact secrets in transcripts.",
    "- Absence of a finding is meaningful only when the test actually ran — report coverage honestly in the run summary.",
  ]
  if (opts.environment === "PRODUCTION") {
    lines.push(
      "- PRODUCTION target: availability takes precedence over coverage. Rate yourself conservatively and never attempt destructive methods."
    )
  }
  if (opts.hasApiSpec) {
    lines.push(
      "- An OpenAPI document is provisioned as an authorized second target; its declared base URLs are in scope."
    )
  }
  if (opts.hasCredentials) {
    lines.push(
      "- Authenticated material is applied by the relay — you will not see it. Test the authenticated surface without handling credentials."
    )
  }
  if (opts.focus && FOCUS_HINTS[opts.focus]) {
    lines.push(
      `- Requested emphasis: ${FOCUS_HINTS[opts.focus]} Emphasis steers attention only — it never reduces required coverage.`
    )
  }
  return lines.join("\n")
}

export function summarizeVibeSecurityCoverage(findings: readonly VibeCoverageFinding[]) {
  const explicitRanks = findings.flatMap((finding) => finding.control_ids ?? [])
  const matchedControlRanks = [
    ...new Set(
      explicitRanks.filter(
        (rank) => Number.isInteger(rank) && rank >= 1 && rank <= VIBE_SECURITY_CONTROLS.length
      )
    ),
  ].sort((left, right) => left - right)
  const evidenceControlRanks = VIBE_SECURITY_CONTROLS.filter(
    (control) => control.strategy === "evidence"
  ).map((control) => control.rank)

  return {
    version: VIBE_SECURITY_COVERAGE_VERSION,
    totalControls: VIBE_SECURITY_CONTROLS.length,
    reviewControlsRequested: VIBE_SECURITY_CONTROLS.length - evidenceControlRanks.length,
    evidenceControlsRequired: evidenceControlRanks.length,
    evidenceControlRanks,
    matchedControlRanks,
  }
}
