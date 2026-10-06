const TITLE_PREFIX = "LyraShield setup for "
const TITLE_SUFFIX = " | LyraShield AI"
const TITLE_LIMIT = 60

/**
 * Concise search-title names for registry identities too long for the
 * 60-character budget. Without these the generic truncator cuts product names
 * mid-word ("GitHub Copilot Cloud A…"). The full displayName still appears in
 * the page H1 and body — this map only shapes the <title>.
 */
const TITLE_NAME_OVERRIDES: Record<string, string> = {
  "GitHub Copilot Cloud Agent": "GitHub Copilot Cloud",
  "GitHub Copilot in VS Code (Agent Plugin)": "Copilot VS Code Plugin",
  "Devin Desktop / Cascade": "Devin Desktop",
}

/** Build a concise title for generated integration guides without changing the visible client name. */
export function buildIntegrationPageTitle(displayName: string): string {
  const rawName = displayName.trim()
  const baseName = TITLE_NAME_OVERRIDES[rawName] ?? rawName
  const unqualifiedName = baseName.replace(/\s*\([^()]*\)\s*$/, "").trim()
  const compactName = unqualifiedName || baseName
  const availableNameLength = TITLE_LIMIT - TITLE_PREFIX.length - TITLE_SUFFIX.length
  const titleName =
    compactName.length <= availableNameLength
      ? compactName
      : `${compactName.slice(0, availableNameLength - 1).trimEnd()}…`

  return `${TITLE_PREFIX}${titleName}${TITLE_SUFFIX}`
}
