import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const REQUIRED_CHECKS = [
  "SCA & Secret Scan",
  "Lint, Typecheck, Test & Build",
  "Pinned Engine / Worker Contract",
]
const SHA = /^[0-9a-f]{40}$/
const RECEIPT =
  /^Detect changed paths \[source: pr=(\d+) base=([0-9a-f]{40}) head=([0-9a-f]{40}) merge=([0-9a-f]{40})\]$/

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Release qualification: ${message}`)
}

// Bound pagination and reject incomplete responses rather than trusting the
// first page. This helper only performs GETs; callers cannot mutate settings.
function list(api, endpoint, key) {
  const result = []
  for (let page = 1; page <= 20; page += 1) {
    const response = api(
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`
    )
    const items = key ? response?.[key] : response
    requireEvidence(Array.isArray(items), `invalid paginated response for ${endpoint}`)
    result.push(...items)
    if (items.length < 100) {
      requireEvidence(!key || response.total_count === result.length, `incomplete ${key} evidence`)
      return result
    }
  }
  throw new Error("Release qualification: pagination limit exceeded")
}

function successful(record) {
  return record?.status === "completed" && record.conclusion === "success"
}

function eligibleWorkflow(run) {
  // Optional jobs may still run or fail after the three required contexts pass.
  // Their bound terminal successes below remain authoritative; no other outer
  // state (including cancellation or a queued rerun) may qualify.
  return (
    (run?.status === "in_progress" && run.conclusion === null) ||
    (run?.status === "completed" && ["success", "failure"].includes(run.conclusion))
  )
}

export function qualifyReleaseSource({ repository, sha, api }) {
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository) && SHA.test(sha), "invalid source identity")
  const root = `repos/${repository}`
  const currentMain = () => api(`${root}/git/ref/heads/main`)?.object?.sha
  requireEvidence(currentMain() === sha, "source is not current main")

  const associated = list(api, `${root}/commits/${sha}/pulls`).filter(
    (pr) => pr.merge_commit_sha === sha && pr.base?.ref === "main"
  )
  requireEvidence(associated.length === 1, "missing or ambiguous associated merged PR")
  const number = associated[0].number
  requireEvidence(Number.isSafeInteger(number) && number > 0, "invalid PR number")
  const pr = api(`${root}/pulls/${number}`)
  requireEvidence(
    pr.merged === true &&
      pr.merge_commit_sha === sha &&
      pr.base?.ref === "main" &&
      pr.base?.repo?.full_name === repository &&
      pr.head?.repo?.full_name === repository &&
      SHA.test(pr.head?.sha) &&
      SHA.test(pr.base?.sha),
    "PR does not identify this merged source"
  )
  const merged = api(`${root}/git/commits/${sha}`)
  requireEvidence(
    merged.sha === sha &&
      SHA.test(merged.tree?.sha) &&
      Array.isArray(merged.parents) &&
      [1, 2].includes(merged.parents.length),
    "unsupported merged commit"
  )
  const base = merged.parents[0]?.sha
  const head = pr.head.sha
  requireEvidence(base === pr.base.sha, "PR base differs from merged first parent")
  requireEvidence(
    merged.parents.length === 1 || merged.parents[1]?.sha === head,
    "merge head differs from PR head"
  )

  const workflow = api(`${root}/actions/workflows/ci.yml`)
  requireEvidence(
    Number.isSafeInteger(workflow.id) && workflow.path === ".github/workflows/ci.yml",
    "CI workflow identity unavailable"
  )
  const runs = list(
    api,
    `${root}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${head}`,
    "workflow_runs"
  )
  requireEvidence(runs.length > 0, "missing CI run")
  // Never fall back to an older success when the latest run lacks required evidence.
  requireEvidence(
    runs.every((run) => Number.isSafeInteger(run.id)),
    "invalid CI run identity"
  )
  runs.sort((a, b) => b.id - a.id)
  requireEvidence(runs.length === 1 || runs[0].id !== runs[1].id, "ambiguous latest CI run")
  const run = api(`${root}/actions/runs/${runs[0].id}`)
  requireEvidence(
    run.id === runs[0].id &&
      run.workflow_id === workflow.id &&
      run.path === workflow.path &&
      run.event === "pull_request" &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.head_sha === head &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      Number.isSafeInteger(run.check_suite_id) &&
      eligibleWorkflow(run),
    "latest CI run is not an eligible repository PR workflow"
  )
  const jobs = list(api, `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs")
  const receipts = jobs.filter((job) => RECEIPT.test(job.name))
  requireEvidence(
    receipts.length === 1 && successful(receipts[0]),
    "missing or ambiguous immutable source receipt"
  )
  const [, testedPr, testedBase, testedHead, syntheticSha] = RECEIPT.exec(receipts[0].name)
  requireEvidence(
    testedPr === String(number) &&
      testedBase === base &&
      testedHead === head &&
      receipts[0].run_id === run.id &&
      receipts[0].head_sha === head,
    "stale PR head/base receipt"
  )
  const synthetic = api(`${root}/git/commits/${syntheticSha}`)
  requireEvidence(
    synthetic.sha === syntheticSha &&
      synthetic.parents?.length === 2 &&
      synthetic.parents[0]?.sha === base &&
      synthetic.parents[1]?.sha === head &&
      synthetic.tree?.sha === merged.tree.sha,
    "tested synthetic merge is not the exact merged source tree"
  )

  for (const name of REQUIRED_CHECKS) {
    const matches = jobs.filter((job) => job.name === name)
    requireEvidence(
      matches.length === 1 && successful(matches[0]),
      `required check unavailable or unsuccessful: ${name}`
    )
    const job = matches[0]
    requireEvidence(
      job.run_id === run.id && job.head_sha === head && Number.isSafeInteger(job.id),
      `unbound CI job: ${name}`
    )
    const checkPrefix = `https://api.github.com/${root}/check-runs/`
    const checkId = job.check_run_url?.startsWith(checkPrefix)
      ? job.check_run_url.slice(checkPrefix.length)
      : ""
    requireEvidence(/^\d+$/.test(checkId), `invalid CI check URL: ${name}`)
    const check = api(`${root}/check-runs/${checkId}`)
    requireEvidence(
      String(check.id) === checkId &&
        check.name === name &&
        successful(check) &&
        check.head_sha === head &&
        check.details_url ===
          `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}` &&
        check.app?.id === 15368 &&
        check.app?.slug === "github-actions" &&
        check.check_suite?.id === run.check_suite_id,
      `required check is not from this GitHub Actions CI suite: ${name}`
    )
  }
  const latestRun = api(`${root}/actions/runs/${run.id}`)
  requireEvidence(
    latestRun.run_attempt === run.run_attempt && eligibleWorkflow(latestRun),
    "CI attempt changed during qualification"
  )
  const latestRuns = list(
    api,
    `${root}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${head}`,
    "workflow_runs"
  )
  requireEvidence(
    latestRuns.length > 0 &&
      latestRuns.every(
        (candidate) => Number.isSafeInteger(candidate.id) && candidate.id <= run.id
      ) &&
      latestRuns.filter((candidate) => candidate.id === run.id).length === 1,
    "latest CI run changed during qualification"
  )
  requireEvidence(currentMain() === sha, "main advanced during qualification")
  return {
    sha,
    pr: number,
    runId: run.id,
    attempt: run.run_attempt,
    syntheticSha,
    mapping: merged.parents.length === 2 ? "merge" : "squash",
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const receipt = qualifyReleaseSource({
      repository: process.env.GITHUB_REPOSITORY ?? "",
      sha: process.env.HEAD_SHA ?? "",
      api(endpoint) {
        return JSON.parse(
          execFileSync("gh", ["api", endpoint], {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
          })
        )
      },
    })
    console.log(`Release source qualified: ${JSON.stringify(receipt)}`)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
