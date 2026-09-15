/**
 * Markdown/link sanitization for model output. The model emits a small
 * markdown subset — bold, italic, inline code, code blocks, lists, links.
 * Everything else (HTML, images, autolinks, raw URLs) is stripped or escaped.
 * Links must be https: on an allowlisted host, or a manifest-relative path.
 * Dependency-free — safe in Workers and the browser.
 */

const ALLOWED_LINK_HOSTS = new Set([
  "lyrashieldai.com",
  "www.lyrashieldai.com",
  "app.lyrashieldai.com",
])

/**
 * Neutralize dangerous constructs in PLAIN TEXT (not just markup):
 * disallowed scheme mentions, inline event-handler attributes and raw tags.
 * Retrieved corpus text is untrusted — a poisoned entry degrades to text.
 */
export function stripDangerousText(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, "")
    .replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/\b(javascript|vbscript|data)\s*:/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/** A KB sourceUrl may only cite the product's own surface or a manifest route. */
export function isTrustedSourceUrl(url: string): boolean {
  const safe = sanitizeLinkHref(url)
  if (safe === null) return false
  if (safe.startsWith("/")) return true
  try {
    const host = new URL(safe).hostname.toLowerCase()
    return (
      host === "lyrashieldai.com" ||
      host.endsWith(".lyrashieldai.com") ||
      host === "localhost" ||
      host === "127.0.0.1"
    )
  } catch {
    return false
  }
}

export function sanitizeLinkHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("/")) {
    // Relative path — no protocol smuggling.
    if (trimmed.startsWith("//")) return null
    return trimmed.length <= 300 ? trimmed : null
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "https:") return null
    if (!ALLOWED_LINK_HOSTS.has(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

/** Escape every HTML-significant char — output is text, never markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export interface SanitizedSegment {
  kind: "text" | "code" | "link"
  text: string
  href?: string
}

/**
 * Reduce model markdown to safe render segments. Supported inline syntax:
 * `code`, **bold**, *italic*, [label](href). Block constructs (``` fences,
 * lists, headings) are passed through as text for the renderer to format —
 * the renderer owns all markup. Unparseable or disallowed links degrade to
 * plain text.
 */
export function sanitizeMarkdown(markdown: string, maxLength = 8000): SanitizedSegment[] {
  const input = markdown.slice(0, maxLength)
  const segments: SanitizedSegment[] = []
  // Order matters: code first so formatting inside code stays literal.
  const tokenRe = /`([^`\n]{1,500})`|\[([^\]\n]{1,200})\]\(([^)\s]{1,300})\)/g
  let last = 0
  for (const match of input.matchAll(tokenRe)) {
    const idx = match.index ?? 0
    if (idx > last) segments.push({ kind: "text", text: input.slice(last, idx) })
    if (match[1] !== undefined) {
      segments.push({ kind: "code", text: match[1] })
    } else {
      const href = sanitizeLinkHref(match[3] ?? "")
      if (href) {
        segments.push({ kind: "link", text: match[2] ?? href, href })
      } else {
        segments.push({ kind: "text", text: match[2] ?? "" })
      }
    }
    last = idx + match[0].length
  }
  if (last < input.length) segments.push({ kind: "text", text: input.slice(last) })
  return segments
}

/**
 * Screen likely secrets/tokens before text reaches the model or persistence.
 * Screening is fallible — callers must still minimize collected data.
 */
const SECRETISH_PATTERNS = [
  /\blsk_[A-Za-z0-9_-]{10,}\b/g, // LyraShield API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, // JWT-ish
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  // No leading \b — '-' is not a word char, so a boundary never matches PEM.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, // Slack
]

export function screenSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0
  let out = text
  for (const re of SECRETISH_PATTERNS) {
    out = out.replace(re, () => {
      redacted += 1
      return "[redacted-secret]"
    })
  }
  return { text: out, redacted }
}
