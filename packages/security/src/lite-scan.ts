export const LITE_CHECK_VERSION = "lite-2026-07-16.1" as const

export type LiteCheckSeverity = "needs_attention" | "worth_reviewing" | "ok"
export type LiteCheckCategory =
  "exposed_secrets" | "security_headers" | "data_layer" | "transport" | "framework"

export type LiteCheck = {
  category: LiteCheckCategory
  severity: LiteCheckSeverity
  title: string
  whatItIs: string
  whyItMatters: string
  learnMoreUrl: string
}

export type LiteCheckResult = {
  target: string
  scannedAt: string
  version: typeof LITE_CHECK_VERSION
  checks: LiteCheck[]
  liteResultSummary: {
    needsAttention: number
    worthReviewing: number
    looksOk: number
    findingCount: number
  }
  disclaimers: string[]
}

type LiteSurface = {
  target: string
  html: string
  publicAssetText?: string
  headers: Record<string, string>
  status?: number
}

const LEARN_MORE_URL = "/methodology"

// These values are designed to be public. They may inform a data-layer signal,
// but must never become an exposed-secret finding.
export const LITE_PUBLIC_VALUE_ALLOWLIST = [
  "Supabase anon and publishable JWTs",
  "Firebase web configuration",
  "Stripe publishable keys",
  "reCAPTCHA site keys",
] as const

const HIGH_CONFIDENCE_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:AWS_SECRET_ACCESS_KEY|SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+]{32,}["']?/gi,
  /\b(?:DATABASE_URL|PRIVATE_KEY|CLIENT_SECRET|API_SECRET|ACCESS_TOKEN)\s*[:=]\s*["'][^"'\s]{16,}["']/gi,
]

function decodeJwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const parsed = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as {
      role?: unknown
    }
    return typeof parsed.role === "string" ? parsed.role : null
  } catch {
    return null
  }
}

function containsSupabaseServiceRole(text: string): boolean {
  const tokens =
    text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []
  return tokens.some((token) => decodeJwtRole(token) === "service_role")
}

function containsGenuineSecret(text: string): boolean {
  if (containsSupabaseServiceRole(text)) return true
  return HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

function finding(
  category: LiteCheckCategory,
  severity: LiteCheckSeverity,
  title: string,
  whatItIs: string,
  whyItMatters: string
): LiteCheck {
  return { category, severity, title, whatItIs, whyItMatters, learnMoreUrl: LEARN_MORE_URL }
}

function headerChecks(headers: Record<string, string>): LiteCheck[] {
  const csp = headers["content-security-policy"]?.toLowerCase()
  const frameProtected = Boolean(headers["x-frame-options"] || csp?.includes("frame-ancestors"))
  const checks: LiteCheck[] = []

  if (!csp) {
    checks.push(
      finding(
        "security_headers",
        "worth_reviewing",
        "Content Security Policy is missing",
        "The page did not return a Content-Security-Policy header.",
        "A well-scoped policy can reduce the impact of injected scripts; it is defense in depth, not a guarantee."
      )
    )
  } else if (
    csp.includes("default-src *") ||
    (csp.includes("script-src") && csp.includes("* 'unsafe-inline'"))
  ) {
    checks.push(
      finding(
        "security_headers",
        "worth_reviewing",
        "Content Security Policy looks unusually broad",
        "A policy is present, but its source rules appear permissive.",
        "Broad script rules can leave less protection against injected content. Review the policy against the resources the app actually needs."
      )
    )
  }

  const required: Array<[string, string, string]> = [
    [
      "strict-transport-security",
      "Strict Transport Security is missing",
      "HSTS tells supporting browsers to keep using HTTPS after a secure visit.",
    ],
    [
      "x-content-type-options",
      "MIME sniffing protection is missing",
      "X-Content-Type-Options: nosniff reduces ambiguous content-type handling.",
    ],
    [
      "referrer-policy",
      "Referrer Policy is missing",
      "A Referrer-Policy limits which page details browsers send when following links.",
    ],
    [
      "permissions-policy",
      "Permissions Policy is missing",
      "A Permissions-Policy can disable browser capabilities the app does not use.",
    ],
  ]
  for (const [name, title, why] of required) {
    const present =
      name === "x-content-type-options"
        ? headers[name]?.toLowerCase() === "nosniff"
        : Boolean(headers[name])
    if (!present) {
      checks.push(
        finding(
          "security_headers",
          "worth_reviewing",
          title,
          `The public response did not include the expected ${name} protection.`,
          `${why} Missing it is a hardening gap, not proof of an exploitable vulnerability.`
        )
      )
    }
  }
  if (!frameProtected) {
    checks.push(
      finding(
        "security_headers",
        "worth_reviewing",
        "Frame embedding protection is missing",
        "Neither X-Frame-Options nor a CSP frame-ancestors rule was visible.",
        "Unexpected framing can enable clickjacking-style interface tricks on sensitive actions."
      )
    )
  }
  if (checks.length === 0) {
    checks.push(
      finding(
        "security_headers",
        "ok",
        "Baseline browser protections are present",
        "The response included the baseline headers checked by this Lite Check.",
        "Header presence is a useful signal, but policy quality and application behavior still need deeper review."
      )
    )
  }
  return checks
}

function detectFramework(text: string): string[] {
  const markers: Array<[RegExp, string]> = [
    [/__NEXT_DATA__|\/_next\//i, "Next.js"],
    [/(?:\/assets\/index-|@vite\/client)/i, "Vite"],
    [/firebase(?:app|Config)|firebaseapp\.com/i, "Firebase"],
    [/supabase\.co|createClient\s*\(/i, "Supabase"],
    [/lovable\.app|lovable-tagger/i, "Lovable"],
    [/bolt\.new/i, "Bolt"],
  ]
  return markers.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

export function analyzeLiteSurface(surface: LiteSurface): LiteCheckResult {
  const text = `${surface.html}\n${surface.publicAssetText ?? ""}`
  const checks: LiteCheck[] = []

  if (containsGenuineSecret(text)) {
    checks.push(
      finding(
        "exposed_secrets",
        "needs_attention",
        "A high-confidence secret pattern is publicly visible",
        "A public page or same-origin client asset contains a pattern associated with a server-side credential. The value is intentionally omitted from this result.",
        "Client-delivered credentials can be copied by any visitor. Rotate the credential and move it behind a server-side boundary."
      )
    )
  } else {
    checks.push(
      finding(
        "exposed_secrets",
        "ok",
        "No high-confidence secret pattern found",
        "This limited pass did not recognize a server-side credential in the fetched public content.",
        "Pattern matching cannot cover every credential format and does not inspect private source or runtime configuration."
      )
    )
  }

  checks.push(...headerChecks(surface.headers))

  const hasSupabase = /(?:supabase\.co|createClient\s*\()/i.test(text)
  const hasFirebase = /(?:firebaseConfig|firebaseapp\.com|initializeApp\s*\()/i.test(text)
  if (hasSupabase || hasFirebase) {
    const provider = [hasSupabase ? "Supabase" : "", hasFirebase ? "Firebase" : ""]
      .filter(Boolean)
      .join(" and ")
    checks.push(
      finding(
        "data_layer",
        "worth_reviewing",
        `${provider} client data layer detected`,
        `Public client markers suggest this app uses ${provider}. Public configuration and anon keys are expected and were not treated as exposed secrets.`,
        "Access safety depends on server-enforced row-level security or security rules. This passive check did not query any table, collection, or authenticated endpoint."
      )
    )
  } else {
    checks.push(
      finding(
        "data_layer",
        "ok",
        "No supported client data-layer marker found",
        "The fetched public content did not expose a Supabase or Firebase marker recognized by this version.",
        "This does not establish how the app stores data or whether its authorization rules are correct."
      )
    )
  }

  let target: URL
  try {
    target = new URL(surface.target)
  } catch {
    throw new Error("analyzeLiteSurface requires an absolute target URL")
  }
  if (target.protocol !== "https:") {
    checks.push(
      finding(
        "transport",
        "needs_attention",
        "The page is not using HTTPS",
        "The final public page was served over HTTP.",
        "Without HTTPS, network intermediaries can read or modify traffic between a visitor and the app."
      )
    )
  } else if (/\b(?:src|href)=["']http:\/\//i.test(surface.html)) {
    checks.push(
      finding(
        "transport",
        "worth_reviewing",
        "The HTTPS page references HTTP content",
        "At least one public asset reference uses an unencrypted HTTP URL.",
        "Browsers may block mixed content, and an unencrypted subresource can weaken the page boundary."
      )
    )
  } else {
    checks.push(
      finding(
        "transport",
        "ok",
        "HTTPS transport looks consistent",
        "The fetched page used HTTPS and no obvious HTTP subresource reference was found.",
        "This is a basic outside-only signal and is not a full certificate or transport-configuration audit."
      )
    )
  }

  const frameworks = detectFramework(text)
  if (/sourceMappingURL\s*=\s*[^\s]+\.map(?:\s|$)/i.test(text)) {
    checks.push(
      finding(
        "framework",
        "worth_reviewing",
        "A client source map is publicly referenced",
        "A linked JavaScript or CSS asset points to a source-map file. This check did not fetch or publish that map.",
        "Production source maps can expose original filenames and client-side implementation detail. Confirm whether public delivery is intentional."
      )
    )
  } else {
    checks.push(
      finding(
        "framework",
        "ok",
        frameworks.length > 0
          ? `Public build signals: ${frameworks.join(", ")}`
          : "No supported framework marker found",
        frameworks.length > 0
          ? "These are ordinary public build fingerprints, not vulnerabilities."
          : "This version did not recognize a supported framework marker in the fetched assets.",
        "Framework detection helps scope a deeper review; it does not determine whether the application is vulnerable."
      )
    )
  }

  const count = (severity: LiteCheckSeverity) =>
    checks.filter((check) => check.severity === severity).length
  const needsAttention = count("needs_attention")
  const worthReviewing = count("worth_reviewing")
  const looksOk = count("ok")

  return {
    target: target.origin,
    scannedAt: new Date().toISOString(),
    version: LITE_CHECK_VERSION,
    checks,
    liteResultSummary: {
      needsAttention,
      worthReviewing,
      looksOk,
      findingCount: needsAttention + worthReviewing,
    },
    disclaimers: [
      "This is a surface-level, passive check — a preview of what LyraShield's full loop does. It can't see everything, and a clean result here isn't a guarantee.",
      "No authenticated access, exploit validation, table queries, or active RLS tests were performed.",
    ],
  }
}
