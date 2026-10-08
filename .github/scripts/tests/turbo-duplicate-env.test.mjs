import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// P3: turbo.json declared MYRA_WRITES_ENABLED twice in both the web dev and web
// start env lists. A duplicated key in a JSON array is silent at parse time and
// only shows up as a confusing diff, so assert the arrays are duplicate-free.
const turboConfig = JSON.parse(
  readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8")
)

function taskConfig(packageName, taskName) {
  return turboConfig.tasks?.[`${packageName}#${taskName}`] ?? {}
}

test("no task declares a duplicate env or passThroughEnv entry", () => {
  const tasks = Object.entries(turboConfig.tasks ?? {})
  assert.ok(tasks.length > 0)
  for (const [name, config] of tasks) {
    for (const key of ["env", "passThroughEnv"]) {
      const list = config[key]
      if (!Array.isArray(list)) continue
      assert.equal(
        new Set(list).size,
        list.length,
        `${name}.${key} must not repeat an entry: ${list.join(", ")}`
      )
    }
  }
})

test("MYRA_WRITES_ENABLED stays a single task-level hash input on the web tasks", () => {
  for (const task of ["dev", "start", "build"]) {
    const env = taskConfig("@lyrashield/web", task).env ?? []
    assert.equal(
      env.filter((name) => name === "MYRA_WRITES_ENABLED").length,
      1,
      `@lyrashield/web#${task} must list MYRA_WRITES_ENABLED exactly once`
    )
  }
})

test("deduplication changed no other env or passthrough entry", () => {
  // The duplicate removal must not have widened or narrowed any credential
  // passthrough list. The web lists keep their 22 entries and the worker lists
  // their 20; only the repeated key was dropped.
  const webDev = taskConfig("@lyrashield/web", "dev")
  const webStart = taskConfig("@lyrashield/web", "start")
  const workerDev = taskConfig("@lyrashield/worker", "dev")
  const workerStart = taskConfig("@lyrashield/worker", "start")
  assert.deepEqual(webDev.passThroughEnv, webStart.passThroughEnv)
  assert.deepEqual(workerDev.passThroughEnv, workerStart.passThroughEnv)
  assert.equal(webDev.passThroughEnv.length, 22)
  assert.equal(workerDev.passThroughEnv.length, 20)
  assert.deepEqual(webDev.env, webStart.env)
  for (const credential of [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "LICENSE_SIGNING_PRIVATE_KEY",
    "RAZORPAY_KEY_SECRET",
    "LLM_API_KEY",
  ]) {
    const owner =
      credential === "LLM_API_KEY"
        ? [workerDev, workerStart]
        : [webDev, webStart]
    for (const config of owner) {
      assert.ok(
        config.passThroughEnv.includes(credential),
        `${credential} must stay passed through`
      )
    }
  }
})
