export interface ParsedRepo {
  /** Provider name, e.g. "github" or "gitlab". */
  repoProvider: string
  repoOwner: string
  repoName: string
  /** Owner/name without host, as stored in repoFullName. */
  repoFullName: string
}

function providerFromHost(host: string): string {
  if (host === "github.com" || host.endsWith(".github.com")) return "github"
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab"
  return host
}

function parseRepoPath(path: string, provider: string): ParsedRepo | undefined {
  const parts = path.split("/").filter(Boolean)
  if (parts.length < 2) return undefined

  // GitHub does not support nested owner groups; be strict to avoid
  // matching non-repo paths such as /owner/repo/pulls/1.
  if (provider === "github" && parts.length !== 2) return undefined

  const name = parts.pop()!
  const owner = parts.join("/")
  return {
    repoProvider: provider,
    repoOwner: owner,
    repoName: name,
    repoFullName: `${owner}/${name}`,
  }
}

/**
 * Parse a repository identifier from a bare owner/repo string, an HTTPS URL, or
 * an SSH git URL. Returns the provider, owner, name, and fullName in a form the
 * LyraShield target API expects.
 *
 * Examples:
 *   - "ecryptoguru/lyrashield-ai"
 *   - "https://github.com/ecryptoguru/lyrashield-ai.git"
 *   - "git@github.com:ecryptoguru/lyrashield-ai.git"
 *   - "https://gitlab.com/group/subgroup/repo"
 */
export function parseRepoIdentifier(input: string): ParsedRepo | undefined {
  const trimmed = input.trim()

  // SSH: git@host:path.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch) {
    const host = sshMatch[1] ?? ""
    const path = sshMatch[2] ?? ""
    const repo = parseRepoPath(path, providerFromHost(host))
    return repo ? { ...repo, repoProvider: providerFromHost(host) } : undefined
  }

  // HTTPS / HTTP URL
  try {
    const url = new URL(trimmed)
    const pathname = url.pathname.replace(/\.git$/, "").replace(/^\//, "")
    if (!pathname) return undefined
    const repo = parseRepoPath(pathname, providerFromHost(url.host))
    return repo ? { ...repo, repoProvider: providerFromHost(url.host) } : undefined
  } catch {
    // not a URL
  }

  // Bare owner/repo (default provider is GitHub for the current product surface).
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const [owner, name] = trimmed.split("/")
    if (owner && name) {
      return {
        repoProvider: "github",
        repoOwner: owner,
        repoName: name,
        repoFullName: `${owner}/${name}`,
      }
    }
  }

  return undefined
}
