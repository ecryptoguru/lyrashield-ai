import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { assertHeldReadiness, pairedReleaseReceipt } from "./paired-release-hold.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const identity = ["123:1", "a".repeat(40), "b".repeat(40), `sha256:${"c".repeat(64)}`]
const receipt = pairedReleaseReceipt(...identity)

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "paired-release-hold-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, "state.json")
  const executable = path.join(directory, "redis-cli")
  symlinkSync(
    path.join(root, ".github/scripts/tests/fixtures/redis-cli-owned-hold.mjs"),
    executable
  )
  // The symlink selects the tracked executable only in this test PATH.
  const state = (value = null, ttl = -1) => writeFileSync(stateFile, JSON.stringify({ value, ttl }))
  state()
  return {
    state,
    read: () => JSON.parse(readFileSync(stateFile, "utf8")),
    run: (command, ids = identity, env = {}) =>
      spawnSync("/bin/sh", ["ops/monitoring/scan-admission.sh", command, ...ids], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          REDIS_URL: "rediss://fixture.invalid:6379",
          FAKE_REDIS_STATE: stateFile,
          ...env,
        },
        encoding: "utf8",
        timeout: 10000,
      }),
  }
}

test("owned persistent latch supports exact idempotent claim, readback and explicit release", (t) => {
  const f = fixture(t)
  for (const operation of ["claim-owned", "claim-owned", "assert-owned"]) {
    const result = f.run(operation)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), receipt)
    assert.deepEqual(f.read(), { value: receipt, ttl: -1 })
  }
  assert.equal(f.run("release-owned").status, 0)
  assert.equal(f.read().value, null)
  assert.notEqual(f.run("release-owned").status, 0)
})

test("foreign, malformed, stale-owner/source and expiring receipts cannot be adopted or released", (t) => {
  const f = fixture(t)
  for (const value of [
    "not-json",
    '{"operator":"on-call"}',
    pairedReleaseReceipt("122:1", ...identity.slice(1)),
    pairedReleaseReceipt(identity[0], "d".repeat(40), ...identity.slice(2)),
  ]) {
    f.state(value)
    for (const operation of ["claim-owned", "assert-owned", "release-owned"]) {
      assert.notEqual(f.run(operation).status, 0)
      assert.equal(f.read().value, value)
    }
  }
  f.state(receipt, 60000)
  assert.notEqual(f.run("assert-owned").status, 0)
  assert.notEqual(f.run("release-owned").status, 0)
  assert.deepEqual(f.read(), { value: receipt, ttl: 60000 })
})

test("malformed identity and every changed identity component fail closed", (t) => {
  const f = fixture(t)
  f.state(receipt)
  for (const ids of [
    ["bad-owner", ...identity.slice(1)],
    ["124:1", ...identity.slice(1)],
    [identity[0], "d".repeat(40), ...identity.slice(2)],
    [identity[0], identity[1], "d".repeat(40), identity[3]],
    [...identity.slice(0, 3), `sha256:${"d".repeat(64)}`],
  ]) {
    assert.notEqual(f.run("release-owned", ids).status, 0)
    assert.equal(f.read().value, receipt)
  }
})

test("concurrent replacement and Redis failure preserve the hold without leaking credentials", (t) => {
  const f = fixture(t)
  f.state(receipt)
  const replacement = pairedReleaseReceipt("124:1", ...identity.slice(1))
  assert.notEqual(
    f.run("release-owned", identity, { FAKE_REDIS_REPLACEMENT: replacement }).status,
    0
  )
  assert.equal(f.read().value, replacement)
  const failed = f.run("claim-owned", identity, {
    FAKE_REDIS_FAILURE: "1",
    REDIS_URL: "rediss://secret-sentinel@fixture.invalid",
  })
  assert.notEqual(failed.status, 0)
  assert.doesNotMatch(failed.stdout + failed.stderr, /secret-sentinel/)
  assert.equal(f.read().value, replacement)
})

test("legacy stop/resume cannot overwrite or delete an owned or foreign hold", (t) => {
  const f = fixture(t)
  f.state(receipt)
  assert.notEqual(f.run("stop", ["on-call", "incident"]).status, 0)
  for (const operator of ["on-call", "github-actions"])
    assert.notEqual(f.run("resume", [operator]).status, 0)
  assert.equal(f.read().value, receipt)
  f.state()
  assert.equal(f.run("stop", ["on-call", "incident"]).status, 0)
  assert.notEqual(f.run("resume", ["another-operator"]).status, 0)
  assert.equal(f.run("resume", ["on-call"]).status, 0)
  assert.equal(f.read().value, null)
})

test("held readiness requires API 200 and expected scan 503 JSON, not an arbitrary outage", () => {
  const healthy = JSON.stringify({ status: "ready", checks: { database: true, redis: true } })
  const held = JSON.stringify({ status: "not_ready", checks: { worker: false } })
  assertHeldReadiness("200", healthy, "503", held)
  for (const args of [
    ["503", healthy, "503", held],
    ["200", healthy, "200", held],
    ["200", "{}", "503", held],
    ["200", healthy, "503", "outage"],
    ["200", healthy, "503", "{}"],
  ]) {
    assert.throws(() => assertHeldReadiness(...args))
  }
})

test("promoter binds the exact reviewed hold module payload", () => {
  const bytes = readFileSync(path.join(root, "ops/monitoring/paired-release-hold.mjs"))
  const digest = createHash("sha256").update(bytes).digest("hex")
  const promoter = readFileSync(path.join(root, ".github/scripts/promote-worker-vm.sh"), "utf8")
  assert.ok(promoter.includes(`digest("hex")!=="${digest}"`))
})

test("receipt identity components must be strings before regex validation", () => {
  for (let index = 0; index < identity.length; index++) {
    for (const value of [[identity[index]], { toString: () => identity[index] }, null, 123]) {
      const input = [...identity]
      input[index] = value
      assert.throws(() => pairedReleaseReceipt(...input), /Invalid paired release identity/)
    }
  }
})

test("manual option-like names remain releasable and ambiguous raw JSON is preserved", (t) => {
  const f = fixture(t)
  assert.equal(f.run("stop", ["--version", "incident"]).status, 0)
  assert.equal(f.run("resume", ["--version"]).status, 0)
  for (const reason of [
    "paired-release",
    "worker-promotion",
    "webhook-claims-cutover",
    "v26-accounting-cutover",
  ]) {
    f.state(JSON.stringify({ operator: "on-call", reason, stoppedAt: "2026-11-03T00:00:00.000Z" }))
    assert.equal(f.run("resume", ["on-call"]).status, 0)
  }
  const ambiguous =
    '{"operator":"on-call","reason":"paired-release","reason":"incident","stoppedAt":"2026-11-03T00:00:00.000Z"}'
  f.state(ambiguous)
  assert.notEqual(f.run("resume", ["on-call"]).status, 0)
  assert.equal(f.read().value, ambiguous)
  const manual = JSON.stringify({
    operator: "on-call",
    reason: "incident",
    stoppedAt: "2026-11-03T00:00:00.000Z",
  })
  const replacement = JSON.stringify({
    operator: "on-call",
    reason: "other",
    stoppedAt: "2026-11-03T00:00:00.000Z",
  })
  f.state(manual)
  assert.notEqual(f.run("resume", ["on-call"], { FAKE_REDIS_REPLACEMENT: replacement }).status, 0)
  assert.equal(f.read().value, replacement)
})

test("oversized manual stop is refused before creating an unreleasable receipt", (t) => {
  const f = fixture(t)
  assert.notEqual(f.run("stop", ["on-call", "x".repeat(4096)]).status, 0)
  assert.equal(f.read().value, null)
})

test("a legitimate oversized legacy manual receipt remains releasable by its owner", (t) => {
  const f = fixture(t)
  f.state(
    JSON.stringify({
      operator: "on-call",
      reason: "x".repeat(4096),
      stoppedAt: "2026-11-03T00:00:00.000Z",
    })
  )
  assert.equal(f.run("resume", ["on-call"]).status, 0)
  assert.equal(f.read().value, null)
})
