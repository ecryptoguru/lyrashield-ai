import minimist from "minimist"
import { LyraShieldError, requestFixPr } from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import { describeCliFailure } from "../failure.js"
import type { Output } from "../output.js"

export async function handleFixPlan(args: string[], output: Output): Promise<number> {
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (args[0] === "create-pr") {
    const parsed = minimist(args.slice(1), { string: ["idempotency-key"] })
    const [proposalId] = parsed._
    if (!proposalId) {
      output.error("usage: lyrashield fix-plan create-pr <proposalId> --idempotency-key <key>")
      return 2
    }
    const idempotencyKey = parsed["idempotency-key"] as string | undefined
    if (!idempotencyKey?.trim()) {
      output.error("--idempotency-key is required to request a fix PR")
      return 2
    }
    try {
      const outcome = await requestFixPr(client, String(proposalId), {
        workspaceId,
        idempotencyKey,
      })
      output.result(outcome)
      // Honest states: a pending approval needs a human click, an opened PR is
      // never auto-merged, and a failure explains why no PR exists.
      if (outcome.status === "pending_approval") {
        output.notice(
          `Fix PR awaiting approval — open ${outcome.approvalUrl} to authorize the exact patch.`
        )
      } else if (outcome.status === "opened") {
        output.notice(`Fix PR opened: ${outcome.prUrl} — nothing merges automatically.`)
      } else {
        output.error(
          `Fix PR was not created (${outcome.status}): ${outcome.reason ?? "unknown reason"}`,
          1
        )
        return 1
      }
      return 0
    } catch (err) {
      if (err instanceof LyraShieldError && err.code === "PATCH_REJECTED") {
        output.error(`Fix PR rejected by the server: ${err.message}`, 1)
        return 1
      }
      const { message, exitCode } = describeCliFailure(err)
      output.error(message, exitCode)
      return exitCode
    }
  }

  if (args[0] === "create") {
    const parsed = minimist(args.slice(1), { string: ["summary"] })
    const [findingId] = parsed._
    const summary = (parsed.summary as string) ?? ""
    if (!findingId) {
      output.error("usage: lyrashield fix-plan create <findingId> --summary <summary>")
      return 2
    }
    if (summary.trim().length < 10) {
      output.error("--summary must be at least 10 characters")
      return 2
    }
    const res = await client.request("POST", `/findings/${findingId}/fix-proposals`, {
      body: { workspaceId, summary },
    })
    output.result(res)
    return 0
  }

  const [findingId] = args
  if (!findingId) {
    output.error(
      "usage: lyrashield fix-plan <findingId> | lyrashield fix-plan create <findingId> --summary <summary> | lyrashield fix-plan create-pr <proposalId> --idempotency-key <key>"
    )
    return 2
  }
  const res = (await client.request(
    "GET",
    `/findings/${findingId}?workspaceId=${encodeURIComponent(workspaceId)}`
  )) as {
    recommendedFix?: string
    plainLanguage?: { howToFix?: string; whatItIs?: string }
  }
  output.result({
    recommendedFix: res.recommendedFix,
    plainLanguage: res.plainLanguage,
  })
  return 0
}
