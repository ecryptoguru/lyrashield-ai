import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const PROMOTION_STEP = "Promote healthy candidate revisions"
const RUNTIME_JOB_NAME = "deploy azure container apps"

function hasRuntimeJobName(jobName) {
  const segments = String(jobName ?? "").split("/")
  return segments.at(-1)?.trim().toLowerCase() === RUNTIME_JOB_NAME
}

export function assertNoPriorRuntimePromotion({ repository, runId, attempt, getAttemptJobs }) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("GitHub run attempt is invalid")
  }
  if (attempt === 1) return
  if (!/^\d+$/.test(String(runId)) || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GitHub run identity is invalid")
  }

  for (let priorAttempt = 1; priorAttempt < attempt; priorAttempt += 1) {
    const response = getAttemptJobs(repository, runId, priorAttempt)
    if (!response || !Array.isArray(response.jobs)) {
      throw new Error(`Attempt ${priorAttempt} job evidence is unreadable`)
    }

    const runtimeJobs = response.jobs.filter((job) => hasRuntimeJobName(job.name))
    if (runtimeJobs.length === 0) {
      throw new Error(`Attempt ${priorAttempt} has no verifiable Azure runtime job record`)
    }

    for (const job of runtimeJobs) {
      if (job.status !== "completed") {
        throw new Error(`Attempt ${priorAttempt} Azure runtime job did not complete`)
      }
      if (job.conclusion === "skipped") continue

      const promotion = Array.isArray(job.steps)
        ? job.steps.find((step) => step.name === PROMOTION_STEP)
        : undefined
      if (!promotion || promotion.status !== "completed" || !promotion.conclusion) {
        throw new Error(`Attempt ${priorAttempt} has incomplete promotion evidence`)
      }
      if (promotion.conclusion !== "skipped") {
        throw new Error(
          `Attempt ${priorAttempt} started runtime promotion; use the reviewed recovery path because the rollback baseline may have changed`
        )
      }
    }
  }
}

function main() {
  const runId = process.env.GITHUB_RUN_ID ?? ""
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  const repository = process.env.GITHUB_REPOSITORY ?? ""
  assertNoPriorRuntimePromotion({
    repository,
    runId,
    attempt,
    getAttemptJobs(ownerRepo, id, number) {
      const endpoint = `repos/${ownerRepo}/actions/runs/${id}/attempts/${number}/jobs?per_page=100`
      const output = execFileSync("gh", ["api", endpoint], { encoding: "utf8" })
      return JSON.parse(output)
    },
  })
  console.log("No earlier attempt started Azure runtime promotion.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
