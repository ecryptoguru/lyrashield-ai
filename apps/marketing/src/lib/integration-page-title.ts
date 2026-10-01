const TITLE_PREFIX = "LyraShield setup for "
const TITLE_SUFFIX = " | LyraShield AI"
const TITLE_LIMIT = 60

/** Build a concise title for generated integration guides without changing the visible client name. */
export function buildIntegrationPageTitle(displayName: string): string {
  const unqualifiedName = displayName
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim()
  const compactName = unqualifiedName || displayName.trim()
  const availableNameLength = TITLE_LIMIT - TITLE_PREFIX.length - TITLE_SUFFIX.length
  const titleName =
    compactName.length <= availableNameLength
      ? compactName
      : `${compactName.slice(0, availableNameLength - 1).trimEnd()}…`

  return `${TITLE_PREFIX}${titleName}${TITLE_SUFFIX}`
}
