export const tools = [
  {
    slug: "ai-app-security-checklist",
    title: "AI App Launch Security Checklist",
    seoTitle: "AI App Security Checklist | LyraShield AI",
    description:
      "Use a free AI app security checklist to document launch controls, find the most important gaps, and prioritize what to verify before release.",
    summary:
      "This browser-local checklist helps builders document 11 launch controls across authorization, tenant isolation, secrets, validation, rate limits, dependencies, agents, logging, testing, and operations.",
    privacy: "No code or target data is collected.",
    category: "Check before launch",
    checks: [
      "Whether you can document each of the 11 listed launch controls",
      "Which undocumented controls should be reviewed first",
      "A versioned checklist result you can use to plan deeper testing",
    ],
    limitations: [
      "It does not inspect your code, configuration, infrastructure, or live application",
      "Checking a box does not verify that a control is implemented correctly",
      "It is not a penetration test, compliance assessment, or security guarantee",
    ],
    references: [
      {
        label: "OWASP Application Security Verification Standard",
        url: "https://owasp.org/www-project-application-security-verification-standard/",
      },
    ],
  },
  {
    slug: "security-headers-checker",
    title: "Security Headers and CORS Checker",
    seoTitle: "Security Headers and CORS Checker | LyraShield AI",
    description:
      "Paste HTTP response headers into this free local checker to review CSP, HSTS, CORS, clickjacking, referrer, permissions, and cookie signals.",
    summary:
      "This local HTTP header checker reviews pasted response headers for common browser-security omissions, permissive CORS signals, framing protection, and missing cookie attributes.",
    privacy: "Headers stay in your browser.",
    category: "Check before launch",
    checks: [
      "Presence of CSP, HSTS, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy",
      "X-Frame-Options or a CSP frame-ancestors directive",
      "Wildcard CORS signals and Secure, HttpOnly, and SameSite cookie attributes",
    ],
    limitations: [
      "It does not fetch your URL or observe redirects, preflight requests, or route-specific behavior",
      "It checks a focused set of names and patterns, not whether every policy value is safe",
      "A clear result does not establish exploitability or overall application security",
    ],
    references: [
      {
        label: "MDN: Content-Security-Policy",
        url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy",
      },
      {
        label: "MDN: Cross-Origin Resource Sharing",
        url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS",
      },
    ],
  },
  {
    slug: "secret-exposure-scanner",
    title: "Secret Exposure Scanner",
    seoTitle: "Free Local Secret Exposure Scanner | LyraShield AI",
    description:
      "Scan selected text files locally for common API keys, access tokens, private keys, and assigned credentials. Matches are redacted and never uploaded.",
    summary:
      "This browser-local secret scanner checks up to 20 selected text files for high-confidence credential patterns and shows redacted matches so you can rotate a real exposure.",
    privacy: "Files never leave your device.",
    category: "Protect data and access",
    checks: [
      "Common OpenAI-compatible, AWS, GitHub, Stripe, Supabase, and Google credential formats",
      "Private-key blocks and assigned API keys, tokens, client secrets, or passwords",
      "Duplicate matches, with likely secret values redacted before display",
    ],
    limitations: [
      "It checks only the text files you select, skips non-text files, and limits each file to 1 MB",
      "Pattern matching can miss custom formats and can flag test or example values",
      "It does not scan Git history, deployed bundles, logs, cloud stores, or already leaked credentials",
    ],
    references: [
      {
        label: "OWASP Secrets Management Cheat Sheet",
        url: "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html",
      },
    ],
  },
  {
    slug: "supabase-rls-checker",
    title: "Supabase RLS Policy Checker",
    seoTitle: "Supabase RLS Policy Checker | LyraShield AI",
    description:
      "Review pasted Supabase RLS policy SQL locally for missing enablement, permissive rules, bypass risks, and absent ownership or tenant predicates.",
    summary:
      "This local Supabase RLS checker reviews pasted SQL for a focused set of risky row-level security patterns before you apply a migration.",
    privacy: "SQL stays in your browser.",
    category: "Protect data and access",
    checks: [
      "ENABLE and FORCE ROW LEVEL SECURITY statements",
      "Always-true policies, SECURITY DEFINER, and service-role references",
      "Obvious user, ownership, workspace, organization, or tenant predicates",
    ],
    limitations: [
      "It does not connect to Supabase or inspect your schema, grants, roles, views, or deployed policies",
      "Static pattern matching cannot evaluate full SQL semantics or application authorization",
      "You still need positive and negative tests with at least two real accounts",
    ],
    references: [
      {
        label: "Supabase: Row Level Security",
        url: "https://supabase.com/docs/guides/database/postgres/row-level-security",
      },
    ],
  },
  {
    slug: "jwt-session-inspector",
    title: "JWT and Session Inspector",
    seoTitle: "JWT and Session Inspector | LyraShield AI",
    description:
      "Decode a non-production JWT locally, inspect algorithm and time claims, and review Secure, HttpOnly, and SameSite attributes on session cookies.",
    summary:
      "This browser-local JWT inspector decodes a token header and claims, highlights basic time and algorithm signals, and reviews pasted session-cookie attributes.",
    privacy: "Tokens are decoded locally and are never verified or sent.",
    category: "Protect data and access",
    checks: [
      "JWT algorithm, issuer, audience, expiration, and not-before claims",
      "Expired, not-yet-valid, missing-expiry, and alg=none signals",
      "Secure, HttpOnly, and SameSite attributes in pasted Set-Cookie values",
    ],
    limitations: [
      "It decodes JWT data but does not verify the signature, issuer, audience, key, or revocation state",
      "Decoded claims are untrusted input and do not prove a session is valid",
      "Use only non-production tokens; this page does not inspect server-side session behavior",
    ],
    references: [
      {
        label: "RFC 7519: JSON Web Token",
        url: "https://www.rfc-editor.org/rfc/rfc7519.html",
      },
      {
        label: "MDN: Set-Cookie",
        url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie",
      },
    ],
  },
] as const

export type Tool = (typeof tools)[number]

export function toolUrl(slug: Tool["slug"]): string {
  return `/tools/${slug}`
}
