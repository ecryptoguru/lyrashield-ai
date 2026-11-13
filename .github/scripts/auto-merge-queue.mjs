import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const repository = "ecryptoguru/lyrashield-ai"
const root = `repos/${repository}`
const sha40 = /^[a-f0-9]{40}$/
const dependabotId = 49699333
const queuedCheckWaitMs = 2 * 60 * 60 * 1000
const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const liveStates = ["in_progress", "requested", "waiting", "pending"]
const requiredChecks = [
  "SCA & Secret Scan",
  "Lint, Typecheck, Test & Build",
  "Pinned Engine / Worker Contract",
]
const sourceReceipt =
  /^Detect changed paths \[source: pr=(\d+) base=([0-9a-f]{40}) head=([0-9a-f]{40}) merge=([0-9a-f]{40})\]$/

function requireValue(condition, message) {
  if (!condition) throw new Error(`Automatic merge: ${message}`)
}

function list(api, path, key) {
  const result = []
  for (let page = 1; page <= 20; page += 1) {
    const response = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
    const items = key ? response?.[key] : response
    requireValue(Array.isArray(items), "invalid paginated response")
    result.push(...items)
    if (items.length < 100) {
      requireValue(!key || response.total_count === result.length, "incomplete paginated response")
      return result
    }
  }
  throw new Error("Automatic merge: pagination limit exceeded")
}

function trusted(pr) {
  const bot = pr.user?.id === dependabotId && pr.user?.login === "dependabot[bot]"
  return (
    pr.state === "open" &&
    pr.draft === false &&
    pr.base?.ref === "main" &&
    pr.base?.repo?.full_name === repository &&
    pr.head?.repo?.full_name === repository &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    sha40.test(pr.head?.sha ?? "") &&
    (bot || trustedAssociations.has(pr.author_association))
  )
}

function isDependabot(pr) {
  return pr.user?.id === dependabotId && pr.user?.login === "dependabot[bot]"
}

// The installation token lacks the workflows permission, so it cannot update a
// branch whose diff touches .github/workflows. Skip those behind PRs for a human.
function touchesWorkflows(api, pr) {
  return list(api, `${root}/pulls/${pr.number}/files`).some((file) =>
    file?.filename?.startsWith(".github/workflows/")
  )
}

function latestCi(api, head) {
  const runs = list(
    api,
    `${root}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}`,
    "workflow_runs"
  )
  requireValue(
    runs.every((run) => Number.isSafeInteger(run.id)),
    "invalid CI run list"
  )
  runs.sort((a, b) => b.id - a.id)
  requireValue(runs.length < 2 || runs[0].id !== runs[1].id, "ambiguous latest CI run")
  return runs[0]
}

function eligibleCi(run) {
  return (
    (run.status === "in_progress" && run.conclusion === null) ||
    (run.status === "completed" && ["success", "failure"].includes(run.conclusion))
  )
}

function requiredCheckState(api, pr, main) {
  const head = pr.head.sha
  const run = latestCi(api, head)
  if (!run) {
    const updated = Date.parse(pr.updated_at)
    const age = Date.now() - updated
    return Number.isFinite(updated) && age >= -60_000 && age < 120_000 ? "pending" : "missing"
  }
  requireValue(
    Number.isSafeInteger(run.id) &&
      Number.isSafeInteger(run.check_suite_id) &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.head_sha === head &&
      run.event === "pull_request" &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository,
    "invalid CI identity"
  )
  if (["queued", "requested", "waiting", "pending"].includes(run.status)) {
    const updated = Date.parse(run.updated_at)
    if (Number.isFinite(updated) && Date.now() - updated > queuedCheckWaitMs) return "stalled"
    return "pending"
  }
  if (!eligibleCi(run)) return "failed"
  const jobs = list(api, `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs")
  const receipts = jobs.filter((job) => sourceReceipt.test(job.name))
  if (receipts.length !== 1 || receipts[0].status !== "completed")
    return run.status === "completed" ? "failed" : "pending"
  const receipt = receipts[0]
  const [, number, base, testedHead, synthetic] = sourceReceipt.exec(receipt.name)
  if (
    receipt.conclusion !== "success" ||
    receipt.run_id !== run.id ||
    receipt.head_sha !== head ||
    number !== String(pr.number) ||
    base !== main ||
    testedHead !== head
  )
    return "failed"
  const merge = api(`${root}/git/commits/${synthetic}`)
  if (
    merge.sha !== synthetic ||
    merge.parents?.length !== 2 ||
    merge.parents[0]?.sha !== main ||
    merge.parents[1]?.sha !== head
  )
    return "failed"
  for (const name of requiredChecks) {
    const matching = jobs.filter((job) => job.name === name)
    if (matching.length !== 1 || matching[0].status !== "completed")
      return run.status === "completed" ? "failed" : "pending"
    const job = matching[0]
    if (
      job.conclusion !== "success" ||
      job.run_id !== run.id ||
      job.head_sha !== head ||
      !Number.isSafeInteger(job.id)
    )
      return "failed"
    const prefix = `https://api.github.com/${root}/check-runs/`
    const checkId = job.check_run_url?.startsWith(prefix)
      ? job.check_run_url.slice(prefix.length)
      : ""
    if (!/^\d+$/.test(checkId)) return "failed"
    const check = api(`${root}/check-runs/${checkId}`)
    if (
      String(check.id) !== checkId ||
      check.name !== name ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      check.head_sha !== head ||
      check.details_url !==
        `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}` ||
      check.app?.id !== 15368 ||
      check.app?.slug !== "github-actions" ||
      check.check_suite?.id !== run.check_suite_id
    )
      return "failed"
  }
  const latest = latestCi(api, head)
  if (
    latest?.id !== run.id ||
    latest.run_attempt !== run.run_attempt ||
    !eligibleCi(latest) ||
    api(`${root}/git/ref/heads/main`)?.object?.sha !== main
  )
    return "pending"
  return "passed"
}

/** Decide and execute at most one branch update or verified automatic merge. */
export function runAutoMergeQueue({ api, updateBranch, mergeReady, disableAutoMerge }) {
  const main = api(`${root}/git/ref/heads/main`)?.object?.sha
  requireValue(sha40.test(main ?? ""), "main identity unavailable")
  // GitHub enforces the live branch protection at merge time. The Actions token
  // cannot read classic protection (Administration: read is unavailable), so the
  // queue independently verifies the exact Actions-bound checks and merge base.

  const releaseRuns = `${root}/actions/workflows/release-production.yml/runs?branch=main`
  const releases = liveStates.flatMap((state) =>
    list(api, `${releaseRuns}&status=${state}`, "workflow_runs")
  )
  releases.push(...list(api, `${releaseRuns}&status=queued&head_sha=${main}`, "workflow_runs"))
  requireValue(
    releases.every((run) => Number.isSafeInteger(run.id)),
    "invalid release identity"
  )
  const releaseActive = releases.length > 0
  const currentReleases = list(api, `${releaseRuns}&head_sha=${main}`, "workflow_runs")
  requireValue(
    currentReleases.every((run) => Number.isSafeInteger(run.id)),
    "invalid release identity"
  )
  const currentRelease = currentReleases.sort((a, b) => b.id - a.id)[0]
  const releaseHealthy =
    currentRelease?.status === "completed" && currentRelease.conclusion === "success"
  const open = list(api, `${root}/pulls?state=open`)
  const candidates = open.filter(trusted)
  candidates.sort((a, b) => {
    const productFirst = Number(isDependabot(a)) - Number(isDependabot(b))
    return productFirst || a.created_at.localeCompare(b.created_at) || a.number - b.number
  })

  const active = candidates.filter((candidate) => candidate.auto_merge)
  if (open.some((candidate) => candidate.auto_merge && !trusted(candidate)))
    return { action: "wait", reason: "untrusted auto-merge request is active" }
  if (active.length) {
    const candidate = active[active.length > 1 ? active.length - 1 : 0]
    const pr = api(`${root}/pulls/${candidate.number}`)
    if (!trusted(pr) || pr.head.sha !== candidate.head.sha || !pr.auto_merge)
      return { action: "wait", reason: "auto-merge request changed" }
    if (
      active.length > 1 ||
      releaseActive ||
      !currentRelease ||
      (isDependabot(pr) && !releaseHealthy) ||
      requiredCheckState(api, pr, main) !== "passed"
    ) {
      disableAutoMerge(pr.number, pr.head.sha)
      return { action: "disable-auto-merge", number: pr.number }
    }
    if (pr.mergeable_state === "behind") {
      if (touchesWorkflows(api, pr)) {
        disableAutoMerge(pr.number, pr.head.sha)
        return { action: "disable-auto-merge", number: pr.number }
      }
      updateBranch(pr.number, pr.head.sha)
      return { action: "update", number: pr.number }
    }
    return { action: "wait", reason: "checks pending", number: pr.number }
  }
  if (releaseActive) return { action: "wait", reason: "production release in progress" }
  if (!currentRelease) return { action: "wait", reason: "current main release not observed" }

  let pendingNumber
  let staleCandidate
  for (const candidate of candidates) {
    if (isDependabot(candidate) && !releaseHealthy) continue
    const pr = api(`${root}/pulls/${candidate.number}`)
    if (!trusted(pr) || pr.head.sha !== candidate.head.sha) continue
    if (pr.mergeable_state === "dirty" || pr.mergeable_state === "unknown" || pr.mergeable === null)
      continue
    if (pr.mergeable_state === "behind") {
      if (!touchesWorkflows(api, pr)) staleCandidate ??= pr
      continue
    }
    if (!["clean", "blocked", "unstable"].includes(pr.mergeable_state)) continue
    const checkState = requiredCheckState(api, pr, main)
    if (["failed", "missing", "stalled"].includes(checkState)) continue
    if (checkState !== "passed") {
      pendingNumber ??= pr.number
      continue
    }
    if (pr.auto_merge) return { action: "wait", reason: "checks pending", number: pr.number }
    mergeReady(pr.number, pr.head.sha)
    return { action: "auto-merge", number: pr.number }
  }
  if (pendingNumber) return { action: "wait", reason: "checks pending", number: pendingNumber }
  if (staleCandidate) {
    updateBranch(staleCandidate.number, staleCandidate.head.sha)
    return { action: "update", number: staleCandidate.number }
  }
  return { action: "wait", reason: "no eligible pull requests" }
}

export function readyMergeArgs(number, head) {
  return [
    "api",
    "--method",
    "PUT",
    `${root}/pulls/${number}/merge`,
    "-f",
    `sha=${head}`,
    "-f",
    "merge_method=squash",
  ]
}

export function verifyReleaseTriggered(
  api,
  mergedSha,
  pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
) {
  requireValue(sha40.test(mergedSha ?? ""), "invalid merged source")
  const path = `${root}/actions/workflows/release-production.yml/runs?branch=main&event=push&head_sha=${mergedSha}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = list(api, path, "workflow_runs").filter(
      (run) =>
        run.head_sha === mergedSha &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.repository?.full_name === repository &&
        run.head_repository?.full_name === repository &&
        Number.isSafeInteger(run.id) &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        [...liveStates, "queued", "completed"].includes(run.status)
    )
    requireValue(runs.length <= 1, "ambiguous production release runs")
    if (runs.length === 1) return runs[0].id
    if (attempt < 19) pause(2000)
  }
  throw new Error("Automatic merge: production release run was not observed")
}

export function retryRead(
  operation,
  pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      const detail = `${error?.code ?? ""} ${error?.stderr ?? ""}`
      if (attempt === 2 || !/ETIMEDOUT|ECONNRESET|EAI_AGAIN|HTTP (429|5\d\d)/.test(detail))
        throw error
      pause((attempt + 1) * 500)
    }
  }
}

function gh(args, readOnly = false) {
  const env = readOnly ? { ...process.env, GH_TOKEN: process.env.GH_READ_TOKEN } : process.env
  const execute = () =>
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      env,
    })
  // Never repeat a mutation after a lost acknowledgement.
  return readOnly ? retryRead(execute) : execute()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  requireValue(process.env.GITHUB_REPOSITORY === repository, "unexpected repository")
  requireValue(
    Boolean(process.env.GH_READ_TOKEN && process.env.GH_TOKEN),
    "GitHub credentials unavailable"
  )
  const result = runAutoMergeQueue({
    api: (endpoint) => JSON.parse(gh(["api", endpoint], true)),
    updateBranch: (number, head) =>
      gh([
        "api",
        "--method",
        "PUT",
        `${root}/pulls/${number}/update-branch`,
        "-f",
        `expected_head_sha=${head}`,
      ]),
    mergeReady: (number, head) => {
      const result = JSON.parse(gh(readyMergeArgs(number, head)))
      requireValue(result.merged === true && sha40.test(result.sha ?? ""), "merge not confirmed")
      const runId = verifyReleaseTriggered(
        (endpoint) => JSON.parse(gh(["api", endpoint], true)),
        result.sha
      )
      process.stdout.write(`${JSON.stringify({ mergedSource: result.sha, releaseRunId: runId })}\n`)
    },
    disableAutoMerge: (number) =>
      gh(["pr", "merge", String(number), "--repo", repository, "--disable-auto"]),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
