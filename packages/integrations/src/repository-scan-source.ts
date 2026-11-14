import { z } from "zod"
import { CreateRepoTargetSchema } from "@lyrashield/types"
import {
  getBranchRefSha,
  getDefaultBranch,
  getMergeBaseSha,
  type GitHubReadOptions,
} from "./github"

export interface RepositoryScanTarget {
  type: string
  workspaceId: string
  installationId?: string | number | null
  repoOwner?: string | null
  repoName?: string | null
  repoFullName?: string | null
  branch?: string | null
}

export interface RepositoryScanSourceOptions extends GitHubReadOptions {
  /** The caller reads current persisted connection state in its scoped DB context. */
  readActiveConnection: () => Promise<unknown>
}

export class RepositorySourceUnavailableError extends Error {
  readonly code = "SCAN_REF_UNRESOLVED"
  constructor() {
    super("Could not resolve the repository to an immutable revision.")
    this.name = "RepositorySourceUnavailableError"
  }
}

const repositoryPart = /^[A-Za-z0-9_.-]{1,100}$/
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const connectionSchema = z.object({
  workspaceId: z.string().min(1),
  type: z.literal("GITHUB"),
  externalId: z.string().min(1),
  status: z.literal("active"),
  deletedAt: z.null(),
})

/** Resolve before creating the immutable plan and before admission takes DB locks. */
export async function resolveRepositoryScanSource(
  target: RepositoryScanTarget,
  options: RepositoryScanSourceOptions
): Promise<{ revision: string } | undefined> {
  if (target.type !== "REPO") return undefined
  try {
    const installationId = Number(target.installationId)
    const owner = target.repoOwner ?? target.repoFullName?.split("/")[0]
    const repo = target.repoName ?? target.repoFullName?.split("/")[1]
    if (
      !target.workspaceId ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      !owner ||
      !repo ||
      !repositoryPart.test(owner) ||
      !repositoryPart.test(repo) ||
      (target.repoFullName &&
        target.repoFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase())
    )
      throw new RepositorySourceUnavailableError()
    const connection = connectionSchema.parse(await options.readActiveConnection())
    if (
      connection.workspaceId !== target.workspaceId ||
      connection.externalId !== String(installationId)
    )
      throw new RepositorySourceUnavailableError()
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000)
    const bounded = { signal, retries: options.retries ?? 0 }
    const ref = target.branch ?? (await getDefaultBranch(installationId, owner, repo, bounded))
    if (!CreateRepoTargetSchema.shape.branch.safeParse(ref).success || signal.aborted)
      throw new RepositorySourceUnavailableError()
    const revision = objectId.test(ref)
      ? await getMergeBaseSha(installationId, owner, repo, ref, ref, bounded)
      : await getBranchRefSha(installationId, owner, repo, ref, bounded)
    if (
      !revision ||
      !objectId.test(revision) ||
      signal.aborted ||
      (objectId.test(ref) && revision.toLowerCase() !== ref.toLowerCase())
    )
      throw new RepositorySourceUnavailableError()
    return { revision: revision.toLowerCase() }
  } catch {
    throw new RepositorySourceUnavailableError()
  }
}
