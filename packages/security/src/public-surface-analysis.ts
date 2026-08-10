import { createHash } from "node:crypto"
import { redactUrlForLogs } from "./ssrf"
import type { SurfaceCollection, SurfaceSubject } from "./public-surface"

export type SurfaceSignalState = "DETECTED" | "OBSERVED"

export type SurfaceSignalSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"

export type SurfaceSignal = {
  id: string
  subjectUrl: string
  controlIds: readonly number[]
  state: SurfaceSignalState
  severity?: SurfaceSignalSeverity
  title: string
  description: string
  remediation?: string
  evidence: Record<string, string | number | boolean | string[]>
}

const DETECTORS = {
  privilegedSecret: "surface.privileged-secret",
  cspMissing: "surface.csp-missing",
  cspOverlyPermissive: "surface.csp-overly-permissive",
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



function signalId(detector: string, subjectUrl: string): string {
  const digest = createHash("sha256").update(subjectUrl).digest("hex").slice(0, 12)
  return `${detector}.${digest}`
}

function subjectText(subject: SurfaceSubject): string {
  return subject.body
}

function collectionText(collection: SurfaceCollection): string {
  return collection.subjects.map(subjectText).join("\n")
}

function detectFramework(text: string): string[] {
  const markers: Array<[RegExp, string]> = [
    [/(__NEXT_DATA__|\/_next\/)/i, "Next.js"],
    [/(?:\/assets\/index-|@vite\/client)/i, "Vite"],
    [/(firebase(?:app|Config)|firebaseapp\.com)/i, "Firebase"],
    [/(supabase\.co|createClient\s*\()/i, "Supabase"],
    [/(lovable\.app|lovable-tagger)/i, "Lovable"],
    [/(bolt\.new)/i, "Bolt"],
  ]
  return markers.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

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

function documentSubject(collection: SurfaceCollection): SurfaceSubject | undefined {
  return collection.subjects.find((s) => s.kind === "document")
}

function cspSignals(subject: SurfaceSubject): SurfaceSignal[] {
  const signals: SurfaceSignal[] = []
  const csp = subject.headers["content-security-policy"]
  const cspLower = csp?.toLowerCase()

  if (!csp) {
    signals.push({
      id: signalId(DETECTORS.cspMissing, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [27],
      state: "DETECTED",
      severity: "MEDIUM",
      title: "Content Security Policy is missing",
      description: "The response did not include the Content-Security-Policy header.",
      remediation:
        "Add a Content-Security-Policy header that allows only the sources the application actually uses.",
      evidence: { header: "content-security-policy" },
    })
  } else if (
    cspLower?.includes("default-src *") ||
    (cspLower?.includes("script-src") && cspLower?.includes("* 'unsafe-inline'"))
  ) {
    signals.push({
      id: signalId(DETECTORS.cspOverlyPermissive, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [27],
      state: "DETECTED",
      severity: "LOW",
      title: "Content Security Policy looks unusually broad",
      description: "A policy is present, but its source rules appear permissive.",
      remediation:
        "Review the policy against the resources the app actually loads and remove wildcard or unsafe-inline rules where possible.",
      evidence: { header: "content-security-policy", value: csp },
    })
  }

  const frameProtected = Boolean(
    subject.headers["x-frame-options"] || cspLower?.includes("frame-ancestors")
  )
  if (!frameProtected) {
    signals.push({
      id: signalId(DETECTORS.frameProtectionMissing, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [27],
      state: "DETECTED",
      severity: "LOW",
      title: "Frame embedding protection is missing",
      description: "Neither X-Frame-Options nor a CSP frame-ancestors rule was visible.",
      remediation:
        "Set X-Frame-Options or a CSP frame-ancestors directive to control framing.",
      evidence: {},
    })
  }

  return signals
}

function headerSignals(subject: SurfaceSubject): SurfaceSignal[] {
  const signals: SurfaceSignal[] = [...cspSignals(subject)]

  const required: Array<[string, string, string, SurfaceSignalSeverity, string]> = [
    [
      "strict-transport-security",
      "Strict Transport Security is missing",
      "HSTS tells supporting browsers to keep using HTTPS after a secure visit.",
      "MEDIUM",
      "Add a Strict-Transport-Security header with a long max-age and includeSubDomains after validating HTTPS everywhere.",
    ],
    [
      "x-content-type-options",
      "MIME sniffing protection is missing",
      "X-Content-Type-Options: nosniff reduces ambiguous content-type handling.",
      "LOW",
      "Set X-Content-Type-Options: nosniff on all responses.",
    ],
    [
      "referrer-policy",
      "Referrer Policy is missing",
      "A Referrer-Policy limits which page details browsers send when following links.",
      "LOW",
      "Set an explicit Referrer-Policy that matches the privacy needs of the app.",
    ],
    [
      "permissions-policy",
      "Permissions Policy is missing",
      "A Permissions-Policy can disable browser capabilities the app does not use.",
      "LOW",
      "Set a Permissions-Policy that disables features the app does not need.",
    ],
  ]

  const detectorByHeader: Record<string, string> = {
    "strict-transport-security": DETECTORS.hstsMissing,
    "x-content-type-options": DETECTORS.nosniffMissing,
    "referrer-policy": DETECTORS.referrerPolicyMissing,
    "permissions-policy": DETECTORS.permissionsPolicyMissing,
  }

  const protocol = new URL(subject.finalUrl).protocol
  const isHttps = protocol === "https:"

  for (const [name, title, why, severity, remediation] of required) {
    if (name === "strict-transport-security" && !isHttps) continue

    const present =
      name === "x-content-type-options"
        ? subject.headers[name]?.toLowerCase() === "nosniff"
        : Boolean(subject.headers[name])
    if (!present) {
      signals.push({
        id: signalId(detectorByHeader[name]!, subject.requestedUrl),
        subjectUrl: subject.requestedUrl,
        controlIds: [27],
        state: "DETECTED",
        severity,
        title,
        description: `The public response did not include the expected ${name} protection. ${why}`,
        remediation,
        evidence: { header: name },
      })
    }
  }

  return signals
}

function cookieSignals(subject: SurfaceSubject): SurfaceSignal[] {
  const rawCookies = subject.headers["set-cookie"]
  if (!rawCookies) return []

  const cookies = rawCookies.split(/\n|,(?=[^;,=\s]+=[^;,]+)/)
  const signals: SurfaceSignal[] = []
  for (const [index, cookie] of cookies.entries()) {
    const name = cookie.split("=", 1)[0]?.trim() ?? `cookie-${index + 1}`
    const looksSensitive = /session|auth|token|jwt|sid/i.test(name)
    if (!looksSensitive) continue

    const missing = [
      !/;\s*secure(?:;|$)/i.test(cookie) ? "Secure" : null,
      !/;\s*httponly(?:;|$)/i.test(cookie) ? "HttpOnly" : null,
      !/;\s*samesite=(?:strict|lax|none)(?:|$)/i.test(cookie) ? "SameSite" : null,
    ].filter(Boolean) as string[]
    if (missing.length === 0) continue

    signals.push({
      id: signalId(`${DETECTORS.insecureCookie}.${index}`, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [28],
      state: "DETECTED",
      severity: missing.includes("Secure") || missing.includes("HttpOnly") ? "HIGH" : "MEDIUM",
      title: `Sensitive cookie ${name} is missing ${missing.join(", ")}`,
      description: `The ${name} cookie appears to carry authentication or session state but is missing required browser protections: ${missing.join(", ")}.`,
      remediation:
        "Set Secure, HttpOnly, and an explicit SameSite policy on every authentication and session cookie.",
      evidence: { cookieName: name, missing },
    })
  }
  return signals
}

function transportSignals(subject: SurfaceSubject): SurfaceSignal[] {
  const signals: SurfaceSignal[] = []
  const url = new URL(subject.finalUrl)

  const httpInHistory = subject.urlHistory.some((u) => new URL(u).protocol === "http:")

  if (url.protocol === "http:") {
    signals.push({
      id: signalId(DETECTORS.insecureTransport, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [29],
      state: "DETECTED",
      severity: "HIGH",
      title: "Application is served over insecure HTTP",
      description: "The target is reachable over cleartext HTTP, allowing network attackers to read or modify requests and responses.",
      remediation:
        "Redirect all HTTP traffic to HTTPS and enable HSTS after confirming every supported subdomain is HTTPS-ready.",
      evidence: { finalProtocol: url.protocol },
    })
  } else if (httpInHistory) {
    signals.push({
      id: signalId(DETECTORS.insecureTransport, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [29],
      state: "DETECTED",
      severity: "MEDIUM",
      title: "Redirect chain included insecure HTTP",
      description: "The scan reached the target through an HTTP redirect. The final page is HTTPS, but the chain exposed traffic in cleartext.",
      remediation:
        "Serve the initial request over HTTPS and redirect HTTP to HTTPS with HSTS.",
      evidence: { finalProtocol: url.protocol },
    })
  }

  if (url.protocol === "https:" && /\b(?:src|href)=["']http:\/\//i.test(subject.body)) {
    signals.push({
      id: signalId(DETECTORS.mixedContent, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [29],
      state: "DETECTED",
      severity: "MEDIUM",
      title: "The HTTPS page references HTTP content",
      description: "At least one public asset reference uses an unencrypted HTTP URL.",
      remediation:
        "Load all subresources over HTTPS or use relative protocol-less URLs.",
      evidence: {},
    })
  }

  return signals
}

function verboseErrorSignals(subject: SurfaceSubject): SurfaceSignal[] {
  const patterns = [
    /Traceback \(most recent call last\)/i,
    /\bat\s+[\w.$<>]+\s+\([^\n()]+:\d+:\d+\)/,
    /SQLSTATE\[[A-Z0-9]+\]/i,
    /Whoops, looks like something went wrong/i,
  ]
  if (!patterns.some((pattern) => pattern.test(subject.body))) return []
  return [
    {
      id: signalId(DETECTORS.verboseError, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [31],
      state: "DETECTED",
      severity: "MEDIUM",
      title: "Verbose error or stack trace exposed",
      description:
        "The response exposes a framework, database, or application stack trace that can reveal internal paths and implementation details.",
      remediation:
        "Return a generic error response to users, disable production debug mode, and send detailed errors only to access-controlled monitoring.",
      evidence: {},
    },
  ]
}

function sourceMapSignals(subject: SurfaceSubject): SurfaceSignal[] {
  const hasSourceMapReference =
    // eslint-disable-next-line security/detect-unsafe-regex
    /sourceMappingURL\s*=\s*[^\s"'<>]+\.map(?:\?[^\s"'<>]*)?/i.test(subject.body) ||
    // eslint-disable-next-line security/detect-unsafe-regex
    /(?:src|href)=["'][^"']+\.map(?:\?[^"']*)?["']/i.test(subject.body)
  if (!hasSourceMapReference) return []
  return [
    {
      id: signalId(DETECTORS.sourceMapReferenced, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [32],
      state: "DETECTED",
      severity: "LOW",
      title: "Source map referenced by production response",
      description:
        "The production response references a JavaScript or CSS source map that may expose original source, internal routes, comments, or embedded configuration.",
      remediation:
        "Do not publish production source maps publicly. Upload them privately to the error-monitoring provider or require authenticated access.",
      evidence: {},
    },
  ]
}

function dataLayerSignals(text: string, subject: SurfaceSubject): SurfaceSignal[] {
  const hasSupabase = /(?:supabase\.co|createClient\s*\()/i.test(text)
  const hasFirebase = /(?:firebaseConfig|firebaseapp\.com|initializeApp\s*\()/i.test(text)
  if (!hasSupabase && !hasFirebase) return []
  const provider = [hasSupabase ? "Supabase" : "", hasFirebase ? "Firebase" : ""]
    .filter(Boolean)
    .join(" and ")
  return [
    {
      id: signalId(DETECTORS.dataLayerObserved, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [],
      state: "OBSERVED",
      title: `${provider} client data layer detected`,
      description: `Public client markers suggest this app uses ${provider}. Public configuration and anon keys are expected and were not treated as exposed secrets.`,
      evidence: { provider },
    },
  ]
}

function frameworkSignals(text: string, subject: SurfaceSubject): SurfaceSignal[] {
  const frameworks = detectFramework(text)
  const hasSourceMap = /sourceMappingURL\s*=\s*[^\s]+\.map(?:\s|$)/i.test(text)
  return [
    {
      id: signalId(DETECTORS.frameworkObserved, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [],
      state: "OBSERVED",
      title:
        frameworks.length > 0
          ? `Public build signals: ${frameworks.join(", ")}`
          : "No supported framework marker found",
      description:
        frameworks.length > 0
          ? "These are ordinary public build fingerprints, not vulnerabilities."
          : "This version did not recognize a supported framework marker in the fetched assets.",
      evidence: { frameworks, hasSourceMap },
    },
  ]
}

function privilegedSecretSignals(text: string, subject: SurfaceSubject): SurfaceSignal[] {
  if (!containsGenuineSecret(text)) return []
  return [
    {
      id: signalId(DETECTORS.privilegedSecret, subject.requestedUrl),
      subjectUrl: subject.requestedUrl,
      controlIds: [3],
      state: "DETECTED",
      severity: "CRITICAL",
      title: "A high-confidence secret pattern is publicly visible",
      description:
        "A public page or same-origin client asset contains a pattern associated with a server-side credential. The value is intentionally omitted from this result.",
      remediation:
        "Move the credential behind a server-side boundary, rotate the exposed value, and audit build artifacts for embedded secrets.",
      evidence: {},
    },
  ]
}

export function isDetectedSignal(signal: SurfaceSignal): boolean {
  return signal.state === "DETECTED"
}

export function analyzePublicSurface(collection: SurfaceCollection): SurfaceSignal[] {
  const signals: SurfaceSignal[] = []
  const document = documentSubject(collection)

  for (const subject of collection.subjects) {
    if (subject.kind === "document") {
      signals.push(...transportSignals(subject))
      signals.push(...headerSignals(subject))
      signals.push(...cookieSignals(subject))
      signals.push(...verboseErrorSignals(subject))
    }

    signals.push(...sourceMapSignals(subject))
  }

  const primarySubject = document ?? collection.subjects[0] ?? ({ requestedUrl: collection.seedUrl } as SurfaceSubject)
  const fullText = collectionText(collection)
  signals.push(...privilegedSecretSignals(fullText, primarySubject))
  signals.push(...dataLayerSignals(fullText, primarySubject))
  signals.push(...frameworkSignals(fullText, primarySubject))

  // Deduplicate by id while preserving order.
  const seen = new Set<string>()
  return signals.filter((signal) => {
    if (seen.has(signal.id)) return false
    seen.add(signal.id)
    return true
  })
}

/**
 * Light adapter: derive a human-readable subject name from a normalized URL.
 * Useful when the real subject is not available.
 */
export function redactedSubjectName(url: string): string {
  return redactUrlForLogs(url)
}
