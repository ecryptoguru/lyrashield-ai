export function normalizePublicHttpUrl(value: string): string {
  const input = value.trim()
  if (!input || input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input))
    throw new Error("invalid URL")

  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
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

  return url.toString()
}
