export const VIBE_SECURITY_COVERAGE_VERSION = "vibe-security-50/1.0.0"

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
    title: "API keys exposed in frontend bundles",
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
    strategy: "engine",
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
    strategy: "deterministic",
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
    strategy: "deterministic",
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
    strategy: "deterministic",
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
    strategy: "deterministic",
    keywords: ["stack trace", "debug output", "verbose error", "debug endpoint"],
  },
  {
    rank: 32,
    title: "Source maps and build-artifact leakage",
    strategy: "deterministic",
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
  const machineControls = VIBE_SECURITY_CONTROLS.filter(
    (control) => control.strategy !== "evidence"
  )
  const evidenceControls = VIBE_SECURITY_CONTROLS.filter(
    (control) => control.strategy === "evidence"
  )
  const checklist = machineControls.map((control) => `${control.rank}. ${control.title}`).join("; ")
  return `Goal: ${goal}. Assess every applicable item in LyraShield ${VIBE_SECURITY_COVERAGE_VERSION}: ${checklist}. Report only evidence-backed findings; do not treat absence of evidence as a vulnerability. For each reported finding, include the applicable checklist ranks in control_ids. Operational evidence controls ${evidenceControls.map((control) => control.rank).join(", ")} require separate human or deployment proof.`
}

export function summarizeVibeSecurityCoverage(findings: readonly VibeCoverageFinding[]) {
  const findingText = findings
    .map((finding) =>
      [finding.title, finding.description, finding.technical_analysis]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
    )
    .join("\n")
  const explicitRanks = findings.flatMap((finding) => finding.control_ids ?? [])
  const matchedControlRanks = [
    ...new Set([
      ...explicitRanks.filter(
        (rank) => Number.isInteger(rank) && rank >= 1 && rank <= VIBE_SECURITY_CONTROLS.length
      ),
      ...VIBE_SECURITY_CONTROLS.filter((control) =>
        control.keywords.some((keyword) => findingText.includes(keyword))
      ).map((control) => control.rank),
    ]),
  ].sort((left, right) => left - right)
  const evidenceControlRanks = VIBE_SECURITY_CONTROLS.filter(
    (control) => control.strategy === "evidence"
  ).map((control) => control.rank)

  return {
    version: VIBE_SECURITY_COVERAGE_VERSION,
    totalControls: VIBE_SECURITY_CONTROLS.length,
    machineControlsRequested: VIBE_SECURITY_CONTROLS.length - evidenceControlRanks.length,
    evidenceControlsRequired: evidenceControlRanks.length,
    evidenceControlRanks,
    matchedControlRanks,
  }
}
