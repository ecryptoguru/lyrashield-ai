/**
 * Shared plain-language finding explanations.
 *
 * Both the web API (`apps/web/src/lib/plain-language.ts`) and the worker
 * engine (`apps/worker/src/engine/plain-language.ts`) previously carried their
 * own copy of this data and drifted (different fallback titles, different
 * params). The CWE catalogue and severity fallbacks live here so both apps
 * explain a finding identically; each app keeps its own `explainFinding`
 * wrapper because they legitimately differ in presentation (the web API adds
 * category-specific titles, the worker appends technical detail).
 *
 * The severity type is re-declared structurally ("INFO" | "LOW" | "MEDIUM" |
 * "HIGH" | "CRITICAL") rather than imported from ./index — index re-exports
 * this module, so importing here would be a cycle.
 *
 * This module is data only — no Prisma, no Node APIs — so it is importable
 * from both @lyrashield/types consumers and the worker.
 */

type PlainLanguageSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface PlainLanguageFinding {
  title: string
  whatItIs: string
  whyItMatters: string
  howToFix: string
  difficulty: "easy" | "medium" | "hard"
  estimatedTimeToFix: string
}

export const CWE_EXPLANATIONS: Record<string, PlainLanguageFinding> = {
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

export const GENERIC_EXPLANATIONS: Record<PlainLanguageSeverity, PlainLanguageFinding> = {
  CRITICAL: {
    title: "Critical-Severity Finding",
    whatItIs:
      "A critical-severity finding signals potentially serious impact if the reported condition applies to your system.",
    whyItMatters:
      "Severity alone does not establish that the condition applies, is reachable, or can be exploited. Review the retained evidence and environment before deciding how to respond.",
    howToFix:
      "Confirm the affected component, configuration, and path. Review the recommended change and retest relevant coverage; seek a qualified review when needed.",
    difficulty: "hard",
    estimatedTimeToFix: "4+ hours",
  },
  HIGH: {
    title: "High-Severity Finding",
    whatItIs:
      "A high-severity rating signals notable potential impact if the reported condition applies to your system.",
    whyItMatters:
      "The practical impact depends on the affected component, configuration, reachable path, privileges, and existing controls. Review that context before setting priority.",
    howToFix:
      "Review the technical details and recommended fix steps. Most high-severity issues have well-documented remediation approaches.",
    difficulty: "medium",
    estimatedTimeToFix: "2-4 hours",
  },
  MEDIUM: {
    title: "Medium-Severity Finding",
    whatItIs:
      "A medium-severity rating describes potential impact if the reported condition applies to your system.",
    whyItMatters:
      "Its relevance depends on the affected component, configuration, reachability, and existing controls. Review the evidence and your release policy before deciding on next steps.",
    howToFix: "Review the recommended fix steps. These are typically straightforward to remediate.",
    difficulty: "easy",
    estimatedTimeToFix: "1-2 hours",
  },
  LOW: {
    title: "Low-Severity Finding",
    whatItIs:
      "A low-severity rating indicates lower potential impact under the rating method. Severity alone does not establish whether the condition applies or is reachable.",
    whyItMatters:
      "Check the affected component and environment to decide whether the finding matters in your system and when to address it.",
    howToFix: "Follow the recommended fix steps. These are usually quick to address.",
    difficulty: "easy",
    estimatedTimeToFix: "30 min",
  },
  INFO: {
    title: "Informational Finding",
    whatItIs:
      "An informational finding records an observation or recommendation; the label alone does not confirm a vulnerability.",
    whyItMatters:
      "Its relevance depends on your environment and policies. Review the observation and decide whether it applies to your system.",
    howToFix: "Review the recommendation and implement it if appropriate for your use case.",
    difficulty: "easy",
    estimatedTimeToFix: "15 min",
  },
}
