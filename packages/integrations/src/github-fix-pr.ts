import { z } from "zod"
import { getInstallationToken } from "./github"
import { githubFetch, GITHUB_API_BASE, GITHUB_HEADERS } from "./github-http"

const PullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  body: z.string().nullable(),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
})

/** Read-only recovery by deterministic branch, including closed and merged PRs. */
export async function inspectFixPrRemote(
  installationId: number,
  owner: string,
  repo: string,
  branchName: string,
  marker: string
): Promise<{
  branchExists: boolean
  pullRequest: null | { number: number; url: string; status: "open" | "closed" | "merged" }
}> {
  const token = await getInstallationToken(installationId)
  const headers = { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS }
  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const query = new URLSearchParams({ state: "all", head: `${owner}:${branchName}`, per_page: "2" })
  const response = await githubFetch(`${base}/pulls?${query}`, { headers })
  if (!response.ok) throw new Error("Unable to reconcile GitHub pull request")
  const pulls = z
    .array(PullSchema)
    .max(1)
    .parse(await response.json())
  const pr = pulls[0]
  if (pr) {
    const fullName = `${owner}/${repo}`.toLowerCase()
    const expectedUrl = `https://github.com/${owner}/${repo}/pull/${pr.number}`
    if (
      pr.head.ref !== branchName ||
      pr.head.repo.full_name.toLowerCase() !== fullName ||
      pr.base.repo.full_name.toLowerCase() !== fullName ||
      !pr.body?.includes(marker) ||
      pr.html_url.toLowerCase() !== expectedUrl.toLowerCase()
    ) {
      throw new Error("GitHub pull request execution identity mismatch")
    }
    return {
      branchExists: true,
      pullRequest: {
        number: pr.number,
        url: pr.html_url,
        status: pr.merged_at ? "merged" : pr.state,
      },
    }
  }
  const branch = await githubFetch(`${base}/git/ref/heads/${encodeURIComponent(branchName)}`, {
    headers,
  })
  if (!branch.ok && branch.status !== 404) throw new Error("Unable to reconcile GitHub branch")
  return { branchExists: branch.ok, pullRequest: null }
}
