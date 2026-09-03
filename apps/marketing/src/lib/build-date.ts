import { execSync } from "node:child_process"

/**
 * Build-time date source for JSON-LD dateModified fields.
 *
 * Previously pages hardcoded a literal date that drifted stale the moment
 * anyone edited the page. This derives the real date from git: the last
 * commit that touched the page's own source file, so editing one page
 * never refreshes another's date. When git is unavailable (a source
 * archive without .git), this returns undefined and the caller must omit
 * the field rather than invent a date.
 */
export function buildDateFor(...paths: string[]): string | undefined {
  try {
    const output = execSync(
      `git log -1 --format=%cI -- ${paths.map((p) => JSON.stringify(p)).join(" ")}`,
      { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
    )
      .toString()
      .trim()
    return output || undefined
  } catch {
    return undefined
  }
}
