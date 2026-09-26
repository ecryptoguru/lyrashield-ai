import minimist from "minimist"
import { requestFixPr } from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleFixPlan(args: string[], output: Output): Promise<number> {
  if (args[0] === "create-pr") {
    const parsed = minimist(args.slice(1), { string: ["idempotency-key"] })
    const [proposalId] = parsed._ as string[]
    if (
      !proposalId ||
      parsed._.length !== 1 ||
      (parsed["idempotency-key"] !== undefined && !parsed["idempotency-key"].trim())
    ) {
      output.error("usage: lyrashield fix-plan create-pr <proposalId> [--idempotency-key <key>]")
      return 2
    }
    const workspaceId = requireWorkspace(await getEffectiveCredentials())
    const client = await createClient()
    output.result(
      await requestFixPr(client, proposalId, {
        workspaceId,
        idempotencyKey: parsed["idempotency-key"],
      })
    )
    return 0
  }
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

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
      "usage: lyrashield fix-plan <findingId> | lyrashield fix-plan create <findingId> --summary <summary>"
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
