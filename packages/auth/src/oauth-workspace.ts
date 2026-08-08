/** Returns the workspace chosen immediately before an OAuth continuation. */
export function activeWorkspaceIdFromCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined

  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=")
    if (separator === -1 || entry.slice(0, separator).trim() !== "activeWorkspaceId") continue
    try {
      const workspaceId = decodeURIComponent(entry.slice(separator + 1).trim())
      return workspaceId || undefined
    } catch {
      return undefined
    }
  }

  return undefined
}
