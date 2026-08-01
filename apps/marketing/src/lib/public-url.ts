export function normalizePublicHttpUrl(value: string): string {
  const input = value.trim()
  if (!input || input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input))
    throw new Error("invalid URL")

  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]")
  const rawHostname = url.hostname.replace(/^\[|\]$/g, "")
  const hostname = rawHostname.normalize("NFKC")
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !hostname ||
    url.username ||
    url.password ||
    hostname.includes("%") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (!hostname.includes(".") && !hostname.includes(":"))
  ) {
    throw new Error("invalid public HTTP URL")
  }

  // Re-apply the normalized hostname so server-side validation sees the same
  // ASCII representation of homograph digits (superscript, fullwidth, circled).
  if (!bracketed) {
    url.hostname = hostname
  }

  return url.toString()
}
