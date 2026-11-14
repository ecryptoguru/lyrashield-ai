import { getBranchRefSha, getDefaultBranch, getMergeBaseSha } from "@lyrashield/integrations"

/** Full lowercase git object IDs (SHA-1 = 40, SHA-256 = 64) pass through as
 * immutable revisions; anything else resolves through the installation. */
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

async function resolveRepoRevision(
  installationId: number,
  owner: string,
  repo: string,
  ref: string
): Promise<string> {
  if (FULL_GIT_OBJECT_ID.test(ref)) return ref.toLowerCase()
  return getBranchRefSha(installationId, owner, repo, ref)
}

export async function resolveReviewChangesSource({
  installationId,
  repoOwner,
  repoName,
  headRef,
  branch,
  baseRef,
}: {
  installationId: number
  repoOwner: string
  repoName: string
  headRef?: string
  branch: string | null
  baseRef: string
}) {
  const headSha = await resolveRepoRevision(
    installationId,
    repoOwner,
    repoName,
    headRef ?? branch ?? (await getDefaultBranch(installationId, repoOwner, repoName))
  )
  const baseSha = await resolveRepoRevision(installationId, repoOwner, repoName, baseRef)
  const mergeBaseSha = await getMergeBaseSha(installationId, repoOwner, repoName, baseSha, headSha)
  return mergeBaseSha
    ? { revision: headSha, baseRevision: baseSha, mergeBaseRevision: mergeBaseSha }
    : null
}
