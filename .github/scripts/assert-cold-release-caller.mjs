import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
export function assertColdReleaseCaller(environment = process.env) {
  assert.equal(environment.GITHUB_REPOSITORY, "ecryptoguru/lyrashield-ai")
  assert.equal(environment.GITHUB_REPOSITORY_ID, "1286618458")
  assert.equal(environment.GITHUB_REPOSITORY_OWNER_ID, "116722580")
  assert.equal(environment.GITHUB_EVENT_NAME, "push")
  assert.equal(environment.GITHUB_REF, "refs/heads/main")
  assert.equal(
    environment.GITHUB_WORKFLOW_REF,
    "ecryptoguru/lyrashield-ai/.github/workflows/release-production.yml@refs/heads/main"
  )
  assert.match(environment.GITHUB_SHA, /^[a-f0-9]{40}$/)
  assert.equal(environment.SOURCE_SHA ?? environment.DEPLOY_SHA, environment.GITHUB_SHA)
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertColdReleaseCaller()
  execFileSync("bash", [".github/scripts/assert-current-main.sh"], {
    stdio: "inherit",
    env: { ...process.env, SOURCE_SHA: process.env.SOURCE_SHA ?? process.env.DEPLOY_SHA },
  })
}
