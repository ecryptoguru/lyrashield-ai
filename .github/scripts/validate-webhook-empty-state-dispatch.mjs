import { spawnSync } from "node:child_process"
const env = process.env
function assert(condition) { if (!condition) throw new Error("Empty-state dispatch is not an exact current-main manual authorization") }
assert(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REPOSITORY_ID === "1286618458" && env.GITHUB_REPOSITORY_OWNER_ID === "116722580")
assert(/^[a-f0-9]{40}$/.test(env.SOURCE_SHA || "") && env.SOURCE_SHA === env.GITHUB_SHA && env.CONFIRMATION === `webhook-empty-state:${env.SOURCE_SHA}`)
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
assert(head.status === 0 && head.stdout.trim() === env.SOURCE_SHA)
const main = spawnSync("gh", ["api", "repos/ecryptoguru/lyrashield-ai/git/ref/heads/main", "--jq", ".object.sha"], { encoding: "utf8" })
assert(main.status === 0 && main.stdout.trim() === env.SOURCE_SHA)
