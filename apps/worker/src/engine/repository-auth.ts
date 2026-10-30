import { repositoryAuthEnv } from "./runner-config"
import { withWorkspaceRLS } from "@lyrashield/db"
import { getRepositoryReadToken } from "@lyrashield/integrations"

export interface RepositoryAuth {
  repoFullName: string
  token: string
}

/** Validate the stored integration before billable work; credentials stay in the engine host only. */
export async function prepareRepositoryAuth(params: {
  workspaceId: string
  target: {
    type: string
    repoProvider: string | null
    repoFullName: string | null
    installationId: string | null
  }
  scanRuntimeBudgetMs: number
  elapsedScanMs: () => number
  isScanCancelled: () => Promise<boolean>
}): Promise<RepositoryAuth | undefined> {
  const { target } = params
  const timeoutMs = params.scanRuntimeBudgetMs - params.elapsedScanMs()
  if (target.type !== "REPO" || !target.installationId) return undefined
  const installation = Number(target.installationId)
  if (
    target.repoProvider !== "github" ||
    !/^\d+$/.test(target.installationId) ||
    !Number.isSafeInteger(installation) ||
    installation <= 0 ||
    !target.repoFullName
  )
    throw new Error("Invalid repository installation identity")
  // Validate the scope before querying the credential provider.
  repositoryAuthEnv({ repoFullName: target.repoFullName, token: "scope" })
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Repository authorization deadline exhausted")
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Repository authorization deadline exhausted")),
      Math.min(timeoutMs, 30_000)
    )
    let checking = false
    poll = setInterval(() => {
      if (checking) return
      checking = true
      void params
        .isScanCancelled()
        .then(
          (cancelled) => {
            if (cancelled) reject(new Error("Repository authorization cancelled"))
          },
          () => reject(new Error("Repository authorization cancelled"))
        )
        .finally(() => {
          checking = false
        })
    }, 250)
  })
  try {
    return await Promise.race([
      deadline,
      (async () => {
        if (await params.isScanCancelled()) throw new Error("Repository authorization cancelled")
        const activeIntegration = () =>
          withWorkspaceRLS(params.workspaceId, (tx) =>
            tx.integration.findFirst({
              where: {
                workspaceId: params.workspaceId,
                type: "GITHUB",
                externalId: target.installationId,
                status: "active",
                deletedAt: null,
              },
              select: { id: true },
            })
          )
        const integration = await activeIntegration()
        if (!integration) throw new Error("Repository integration is unavailable")
        const auth = {
          repoFullName: target.repoFullName!,
          token: await getRepositoryReadToken(installation, target.repoFullName!),
        }
        const currentIntegration = await activeIntegration()
        if (currentIntegration?.id !== integration.id)
          throw new Error("Repository integration is unavailable")
        if (await params.isScanCancelled()) throw new Error("Repository authorization cancelled")
        repositoryAuthEnv(auth)
        return auth
      })(),
    ])
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
  }
}
