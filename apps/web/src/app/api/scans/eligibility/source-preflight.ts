import type { Target } from "@lyrashield/db"
import { CreateRepoTargetSchema } from "@lyrashield/types"
import { getBranchRefSha, getDefaultBranch, getMergeBaseSha } from "@lyrashield/integrations"
import type { ScanSetupInput } from "./evidence"

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/
const SOURCE_TIMEOUT_MS = 5_000

function objectId(value: string | null): string {
  if (!value || !GIT_OBJECT_ID.test(value)) throw new Error("Repository revision is unavailable")
  return value.toLowerCase()
}

/** Observe refs without granting admission. Missing credentials or identity stay unavailable. */
export async function readSetupSourceIdentity(
  target: Target,
  input: ScanSetupInput,
  connection: unknown,
  requestSignal: AbortSignal
): Promise<unknown> {
  if (target.type !== "REPO") return null
  if (
    !connection ||
    typeof connection !== "object" ||
    !("status" in connection) ||
    connection.status !== "active"
  )
    return "UNAVAILABLE"
  const installationId = Number(target.installationId)
  const owner = target.repoOwner ?? target.repoFullName?.split("/")[0]
  const repo = target.repoName ?? target.repoFullName?.split("/")[1]
  if (
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    !owner ||
    !repo ||
    !REPOSITORY_PART.test(owner) ||
    !REPOSITORY_PART.test(repo)
  )
    return "UNAVAILABLE"

  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)])
  const options = { signal, retries: 0 }
  const observe = async () => {
    const assertActive = () => {
      if (signal.aborted) throw new Error("Repository observation cancelled")
    }
    const headRef =
      input.headRef ??
      target.branch ??
      (await getDefaultBranch(installationId, owner, repo, options))
    assertActive()
    if (!CreateRepoTargetSchema.shape.branch.safeParse(headRef).success)
      throw new Error("Invalid source ref")
    const resolve = async (ref: string) =>
      GIT_OBJECT_ID.test(ref)
        ? objectId(ref)
        : objectId(await getBranchRefSha(installationId, owner, repo, ref, options))
    const head = await resolve(headRef)
    assertActive()
    if (input.workflow === "REVIEW_CHANGES") {
      if (!input.baseRef) throw new Error("Missing comparison base")
      const base = await resolve(input.baseRef)
      assertActive()
      const mergeBase = objectId(
        await getMergeBaseSha(installationId, owner, repo, base, head, options)
      )
      return { head, base, mergeBase }
    }
    if (GIT_OBJECT_ID.test(headRef)) {
      const confirmed = objectId(
        await getMergeBaseSha(installationId, owner, repo, head, head, options)
      )
      assertActive()
      if (confirmed !== head) throw new Error("Unconfirmed source revision")
    }
    return { head, base: null, mergeBase: null }
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Repository observation timed out"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([observe(), aborted])
  } catch {
    return "UNAVAILABLE"
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}
