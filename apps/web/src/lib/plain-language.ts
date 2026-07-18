import type { FindingSeverity } from "@lyrashield/db"

export interface PlainLanguageFinding {
  title: string
  whatItIs: string
  whyItMatters: string
  howToFix: string
  difficulty: "easy" | "medium" | "hard"
  estimatedTimeToFix: string
}

const CWE_EXPLANATIONS: Record<string, PlainLanguageFinding> = {
  "CWE-79": {
    title: "Cross-Site Scripting (XSS)",
    whatItIs:
      "Your application allows user input to be displayed on a page without proper sanitization. This means an attacker can inject malicious scripts that run in other users' browsers.",
    whyItMatters:
      "If exploited, an attacker can steal user sessions, redirect users to phishing sites, or deface your application. This is especially dangerous for apps handling authentication or sensitive data.",
    howToFix:
      "Escape all user-generated content before rendering it in HTML. Use framework built-in escaping (React's JSX auto-escaping, Django's autoescape, etc.). For rich text, use an allowlist-based sanitizer like DOMPurify.",
    difficulty: "easy",
    estimatedTimeToFix: "1-2 hours per affected endpoint",
  },
  "CWE-89": {
    title: "SQL Injection",
    whatItIs:
      "Your application constructs database queries by concatenating user input directly into SQL strings. An attacker can manipulate these queries to read, modify, or delete your entire database.",
    whyItMatters:
      "This is one of the most severe vulnerabilities in web security. A successful attack can expose all user data, bypass authentication, and in some cases give the attacker full control of the server.",
    howToFix:
      "Use parameterized queries or prepared statements everywhere. Never build SQL strings with user input. If using an ORM, ensure you're using its query builder correctly — not raw query strings with interpolation.",
    difficulty: "easy",
    estimatedTimeToFix: "30 min per affected query",
  },
  "CWE-352": {
    title: "Cross-Site Request Forgery (CSRF)",
    whatItIs:
      "Your application accepts state-changing requests without verifying they came from an authenticated user's intentional action. An attacker can craft a page that triggers actions on your app when a logged-in user visits it.",
    whyItMatters:
      "An attacker can make users perform actions they didn't intend — changing passwords, making transfers, deleting data — just by having them visit a malicious page.",
    howToFix:
      "Implement anti-CSRF tokens for all state-changing requests (POST, PUT, DELETE). Use SameSite cookie attributes. Modern frameworks like Next.js, Django, and Rails have built-in CSRF protection — make sure it's enabled.",
    difficulty: "easy",
    estimatedTimeToFix: "1-2 hours",
  },
  "CWE-287": {
    title: "Improper Authentication",
    whatItIs:
      "Your authentication mechanism has a flaw that allows users to access accounts or resources without proper credentials.",
    whyItMatters:
      "Attackers can impersonate legitimate users, access private data, and perform actions on behalf of others. This completely breaks the trust model of your application.",
    howToFix:
      "Review your authentication flow for edge cases. Ensure password reset tokens are single-use and expire. Use established auth libraries rather than rolling your own. Implement rate limiting on auth endpoints.",
    difficulty: "medium",
    estimatedTimeToFix: "2-4 hours",
  },
  "CWE-22": {
    title: "Path Traversal",
    whatItIs:
      "Your application allows file paths from user input without validation, letting attackers access files outside the intended directory.",
    whyItMatters:
      "Attackers can read sensitive files like configuration, credentials, or source code. In some cases, they can write files to arbitrary locations.",
    howToFix:
      "Never trust user input for file paths. Use allowlists for filenames. Resolve paths and verify they're within the expected directory. Use framework-provided file APIs that handle this safely.",
    difficulty: "easy",
    estimatedTimeToFix: "30 min per affected path",
  },
  "CWE-798": {
    title: "Use of Hard-coded Credentials",
    whatItIs:
      "Your code contains hardcoded passwords, API keys, or other secrets that are visible in the source code.",
    whyItMatters:
      "Anyone with access to the code — including your version control history — can see these credentials. If the repo is public or leaked, attackers have direct access to your systems.",
    howToFix:
      "Move all secrets to environment variables or a secret manager (like AWS Secrets Manager, HashiCorp Vault, or Doppler). Rotate any credentials that were hardcoded. Add pre-commit hooks to scan for secrets.",
    difficulty: "easy",
    estimatedTimeToFix: "15 min per secret",
  },
  "CWE-200": {
    title: "Information Exposure",
    whatItIs:
      "Your application exposes sensitive information — error messages, stack traces, internal data — to users who shouldn't see it.",
    whyItMatters:
      "Attackers use this information to understand your application's architecture, find other vulnerabilities, and plan targeted attacks.",
    howToFix:
      "Disable detailed error messages in production. Use generic error pages. Ensure API responses don't leak internal state. Check that debug mode is off in production.",
    difficulty: "easy",
    estimatedTimeToFix: "30 min",
  },
  "CWE-918": {
    title: "Server-Side Request Forgery (SSRF)",
    whatItIs:
      "Your application makes HTTP requests based on user input without validating the destination URL. An attacker can make your server request internal resources.",
    whyItMatters:
      "Attackers can access internal services, cloud metadata endpoints, and other resources that are only reachable from your server. This can expose credentials, internal APIs, and infrastructure details.",
    howToFix:
      "Validate and restrict outbound URLs against an allowlist. Block requests to private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x). Use a dedicated HTTP client with SSRF protections.",
    difficulty: "medium",
    estimatedTimeToFix: "2-3 hours",
  },
}

const GENERIC_EXPLANATIONS: Record<FindingSeverity, PlainLanguageFinding> = {
  CRITICAL: {
    title: "Critical Security Issue",
    whatItIs:
      "A critical vulnerability was detected that could allow attackers to compromise your application or data.",
    whyItMatters:
      "Critical vulnerabilities are typically exploitable with minimal effort and can result in full system compromise, data breach, or service disruption. These must be fixed before any production deployment.",
    howToFix:
      "Review the technical details of this finding carefully. The fix will depend on the specific vulnerability type. If you're unsure how to proceed, consider consulting a security professional.",
    difficulty: "hard",
    estimatedTimeToFix: "4+ hours",
  },
  HIGH: {
    title: "High-Severity Security Issue",
    whatItIs:
      "A high-severity vulnerability was found that poses a significant risk to your application's security.",
    whyItMatters:
      "These issues are often exploitable and can lead to data exposure, privilege escalation, or service degradation. They should be addressed promptly.",
    howToFix:
      "Review the technical details and recommended fix steps. Most high-severity issues have well-documented remediation approaches.",
    difficulty: "medium",
    estimatedTimeToFix: "2-4 hours",
  },
  MEDIUM: {
    title: "Medium-Severity Security Issue",
    whatItIs:
      "A medium-severity vulnerability was detected. While not immediately critical, it weakens your overall security posture.",
    whyItMatters:
      "Medium issues can be combined with other vulnerabilities to create more serious attack paths. They should be fixed as part of your regular security maintenance.",
    howToFix: "Review the recommended fix steps. These are typically straightforward to remediate.",
    difficulty: "easy",
    estimatedTimeToFix: "1-2 hours",
  },
  LOW: {
    title: "Low-Severity Security Issue",
    whatItIs:
      "A low-severity issue was found. It represents a minor security weakness that's unlikely to be directly exploitable.",
    whyItMatters:
      "Low-severity issues contribute to your overall risk score and can sometimes be chained with other vulnerabilities. Fix them when convenient.",
    howToFix: "Follow the recommended fix steps. These are usually quick to address.",
    difficulty: "easy",
    estimatedTimeToFix: "30 min",
  },
  INFO: {
    title: "Informational Finding",
    whatItIs:
      "An informational finding was reported. This is not a vulnerability but a security observation or best practice recommendation.",
    whyItMatters:
      "Informational findings don't pose a direct risk but addressing them improves your overall security hygiene.",
    howToFix: "Review the recommendation and implement it if appropriate for your use case.",
    difficulty: "easy",
    estimatedTimeToFix: "15 min",
  },
}

const CATEGORY_LABELS: Record<string, string> = {
  injection: "Injection Vulnerability",
  xss: "Cross-Site Scripting",
  csrf: "Cross-Site Request Forgery",
  ssrf: "Server-Side Request Forgery",
  auth: "Authentication Issue",
  crypto: "Cryptographic Weakness",
  config: "Security Misconfiguration",
  disclosure: "Information Disclosure",
  access_control: "Access Control Issue",
  deserialization: "Deserialization Issue",
  dependencies: "Vulnerable Dependency",
  secrets: "Exposed Secret",
}

export function explainFinding(params: {
  title: string
  severity: FindingSeverity
  cwe?: string | null
  category?: string | null
  recommendedFix?: string | null
}): PlainLanguageFinding {
  if (params.cwe && CWE_EXPLANATIONS[params.cwe]) {
    const explanation = CWE_EXPLANATIONS[params.cwe]!
    if (params.recommendedFix) {
      return { ...explanation, howToFix: params.recommendedFix }
    }
    return { ...explanation }
  }

  const generic = GENERIC_EXPLANATIONS[params.severity]!
  const categoryLabel = params.category ? CATEGORY_LABELS[params.category] : null
  const title = categoryLabel ?? params.title
  if (params.recommendedFix) {
    return { ...generic, title, howToFix: params.recommendedFix }
  }
  return { ...generic, title }
}
