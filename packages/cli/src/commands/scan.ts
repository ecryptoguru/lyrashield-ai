import { parseSarifReport } from "@lyrashield/security"
/* eslint-disable security/detect-non-literal-fs-filename */
import minimist from "minimist"
import { readFile } from "fs/promises"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import { followScan, parseWaitTimeout } from "../scan-follow.js"
import { parseRepoIdentifier, type ParsedRepo } from "@lyrashield/sdk"
import {
  findOrCreateRepoTarget,
  loadDefaultProject,
  resolveRepoFromPath,
  saveDefaultProject,
} from "../projects.js"

const VALID_GOALS = [
  "CHECK_PR",
  "TEST_APP",
  "LAUNCH_REVIEW",
  "WEEKLY_MONITOR",
  "FULL_PENTEST",
  "COMPLIANCE_REVIEW",
]
const VALID_MODES = ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"]

async function resolveTarget(
  args: {
    targetId?: string
    auto?: boolean
    repo?: string
    name?: string
    workspaceId: string
  },
  output: Output
): Promise<{ targetId: string; repository?: string; isNew: boolean } | null> {
  // 1. Explicit target wins.
  if (args.targetId) return { targetId: args.targetId, isNew: false }

  // 2. Explicit repository selection wins over an implicit saved default.
  if (args.auto || args.repo) {
    const client = await createClient()

    let repo: ParsedRepo | undefined
    if (args.repo) {
      repo = parseRepoIdentifier(args.repo)
      if (!repo) {
        output.error(`Invalid repo format: ${args.repo}`)
        return null
      }
    } else {
      const resolved = await resolveRepoFromPath()
      if (!resolved.repo) {
        output.error("No git origin remote found. Run from a git repo, or pass --repo.")
        return null
      }
      repo = resolved.repo
    }

    const target = await findOrCreateRepoTarget(client, args.workspaceId, repo, args.name)
    await saveDefaultProject({
      workspaceId: args.workspaceId,
      targetId: target.id,
      name: target.name,
      repository: repo.repoFullName,
    })
    return { targetId: target.id, repository: repo.repoFullName, isNew: true }
  }

  // 3. Use the saved default project only if it belongs to this workspace.
  const defaultProject = await loadDefaultProject()
  if (defaultProject?.targetId && defaultProject.workspaceId === args.workspaceId) {
    return { targetId: defaultProject.targetId, isNew: false }
  }

  return null
}

export async function handleScan(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: [
      "target",
      "goal",
      "mode",
      "repo",
      "name",
      "idempotency-key",
      "sarif",
      "scan-id",
      "base",
      "head",
      "attachment",
      "timeout",
    ],
    boolean: ["watch", "wait", "auto"],
    default: { goal: "TEST_APP", mode: "STANDARD" },
    alias: { t: "target", g: "goal", m: "mode" },
  })

  const wait = parsed.watch || parsed.wait
  const timeoutMs = parseWaitTimeout(parsed.timeout)
  if (wait && timeoutMs === null) {
    output.error("--timeout must be an integer from 1 to 86400 seconds")
    return 2
  }

  const client = await createClient()
  const workspaceId = requireWorkspace(await getEffectiveCredentials())

  const sarifPath = parsed.sarif as string | undefined

  // --attachment is repeatable and references attachment ids that were
  // already uploaded to the workspace; the CLI never uploads local files.
  // These checks are UX only — the server keeps authoritative validation.
  const attachmentArgs = parsed.attachment as string | string[] | undefined
  const attachmentIds = [
    ...new Set(
      (Array.isArray(attachmentArgs) ? attachmentArgs : [attachmentArgs])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
    ),
  ]
  if (attachmentIds.some((id) => !id)) {
    output.error("--attachment requires a non-empty id of an already-uploaded attachment.")
    return 2
  }
  if (parsed["scan-id"] && attachmentIds.length > 0) {
    output.error("--attachment selects inputs for a new scan; it cannot combine with --scan-id.")
    return 2
  }

  let sarifJson: unknown
  if (parsed["scan-id"] && !sarifPath) {
    output.error("--scan-id requires --sarif; it imports into an existing scan.")
    return 2
  }
  if (sarifPath) {
    try {
      sarifJson = JSON.parse(await readFile(sarifPath, "utf-8"))
      const checked = parseSarifReport(sarifJson, "cli-preflight")
      if ("error" in checked) throw new Error(checked.error)
    } catch {
      output.error(`Cannot read a valid SARIF 2.1.0 file: ${sarifPath}; no scan was submitted.`)
      return 2
    }
  }

  const [targetId] = parsed._ as string[]
  const resolved = parsed["scan-id"]
    ? { targetId: "", isNew: false, repository: undefined }
    : await resolveTarget(
        {
          targetId: (parsed.target as string) ?? targetId,
          auto: parsed.auto as boolean,
          repo: parsed.repo as string | undefined,
          name: parsed.name as string | undefined,
          workspaceId,
        },
        output
      )

  if (!resolved) {
    output.error("No target specified.")
    output.notice(
      "usage: lyrashield scan --target <targetId> [--goal ...] [--mode ...] [--attachment <id>...]"
    )
    output.notice(
      "       --attachment <id> references an attachment already uploaded to the workspace; repeat the flag for several"
    )
    output.notice("       lyrashield scan --auto [--repo owner/repo] [--name ...]")
    output.notice("       lyrashield project use  # set a default project once")
    return 2
  }

  const goal = (parsed.goal as string).toUpperCase()
  if (!VALID_GOALS.includes(goal)) {
    output.error(`Invalid goal. Choose: ${VALID_GOALS.join(", ")}`)
    return 2
  }

  const mode = (parsed.mode as string).toUpperCase()
  if (!VALID_MODES.includes(mode)) {
    output.error(`Invalid mode. Choose: ${VALID_MODES.join(", ")}`)
    return 2
  }

  // Review Changes: --base/--head submit a RECORDED diff-scope scan. The
  // server resolves both refs to immutable git object IDs through the
  // authorized GitHub integration and persists them in the execution plan;
  // this is unrelated to `check-diff`, which stays a local advisory check.
  const baseRef = parsed.base as string | undefined
  const headRef = parsed.head as string | undefined
  if (headRef && !baseRef) {
    output.error("--head requires --base so the change set can be compared.")
    return 2
  }
  if (parsed["scan-id"] && (baseRef || headRef)) {
    output.error(
      "--base/--head start a new Review Changes scan; they cannot combine with --scan-id."
    )
    return 2
  }

  const res = parsed["scan-id"]
    ? { id: parsed["scan-id"] as string }
    : ((await client.request("POST", "/scans", {
        body: {
          workspaceId,
          targetId: resolved.targetId,
          goal,
          mode,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(baseRef
            ? {
                workflow: "REVIEW_CHANGES",
                baseRef,
                ...(headRef ? { headRef } : {}),
              }
            : {}),
        },
        headers: { "Idempotency-Key": parsed["idempotency-key"] ?? crypto.randomUUID() },
      })) as { id: string })

  if (resolved.isNew && resolved.repository) {
    output.log(`Resolved project ${resolved.repository} → target ${resolved.targetId}`)
  }

  // --sarif <file> pushes a third-party SARIF 2.1.0 report against the new
  // scan: findings land tagged external_import and never count as coverage.
  if (sarifPath) {
    try {
      const importRes = (await client.request(
        "POST",
        `/scans/${encodeURIComponent(res.id)}/artifacts/sarif?workspaceId=${encodeURIComponent(workspaceId)}`,
        { body: sarifJson }
      )) as { imported: number; corroborated: number; rejected: number; toolName: string | null }
      output.log(
        `Imported ${importRes.imported} SARIF finding(s) from ${importRes.toolName ?? "external tool"}` +
          (importRes.corroborated > 0 ? ` (${importRes.corroborated} corroborated)` : "") +
          (importRes.rejected > 0 ? ` (${importRes.rejected} rejected)` : "")
      )
    } catch (err) {
      // The scan was already created — say so; the import can be retried.
      output.error(
        `SARIF import failed (${err instanceof Error ? err.message : "request error"}); use the existing scan ${res.id}; retry without creating another scan: lyrashield scan --scan-id ${res.id} --sarif ${JSON.stringify(sarifPath)}`
      )
      return 2
    }
  }

  if (wait) {
    process.stderr.write(`Scan accepted: ${res.id}; resume: lyrashield status ${res.id} --watch\n`)
    return followScan(client, res.id, workspaceId, timeoutMs!, output)
  }
  output.result(res)
  return 0
}
