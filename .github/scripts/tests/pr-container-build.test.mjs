import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
const release = readFileSync(".github/workflows/deploy-azure.yml", "utf8")

const jobSection = (source, name) => {
  const section = source.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:/)[0]
  assert.ok(section, `expected job ${name}`)
  return section
}

const buildSteps = (section) => {
  const steps = []
  for (const body of section.split(/(?=      - name: )/)) {
    const action = body.match(/uses: docker\/build-push-action@([0-9a-f]{40})/)
    if (!action) continue
    steps.push({ name: body.match(/- name: ([^\n]+)/)?.[1], actionSha: action[1], body })
  }
  return steps
}

const field = (body, name) => body.match(new RegExp(`^\\s{10}${name}: (.*)$`, "m"))?.[1]?.trim()

test("PR container builds reuse the production targets, context and engine pin without pushing", () => {
  const job = jobSection(workflow, "container-build")
  const prodJob = jobSection(release, "build")

  const prSteps = buildSteps(job)
  const prodSteps = buildSteps(prodJob)
  assert.equal(prSteps.length, 3, "PR gate must build web, worker and egress-proxy")
  assert.deepEqual(
    prSteps.map((step) => field(step.body, "target")).sort(),
    prodSteps.map((step) => field(step.body, "target")).sort()
  )
  assert.deepEqual(prSteps.map((step) => field(step.body, "target")).sort(), [
    "egress-proxy",
    "runner",
    "worker",
  ])

  for (const step of prSteps) {
    assert.equal(field(step.body, "context"), ".", `${step.name}: context must match production`)
    assert.equal(field(step.body, "push"), "false", `${step.name}: PR gate must never push`)
    assert.equal(step.actionSha, "c3c9e263c25d99ce0380d002d59b67737d91b0dc")
    // Cache stays bound to this job: per-target scopes, never the production
    // (unscoped) entries release builds read.
    assert.match(step.body, /cache-from: type=gha,scope=container-build-/)
    assert.match(step.body, /cache-to: type=gha,mode=max,scope=container-build-/)
    // No production inputs may leak into a pull_request job.
    assert.doesNotMatch(step.body, /secrets\.|vars\.|id-token|environment:/)
  }

  for (const step of prodSteps) {
    assert.equal(field(step.body, "context"), ".")
    assert.equal(field(step.body, "push"), "true")
  }

  // The worker image embeds the pinned engine source in both jobs.
  const prWorker = prSteps.find((step) => field(step.body, "target") === "worker")
  const prodWorker = prodSteps.find((step) => field(step.body, "target") === "worker")
  assert.match(prWorker.body, /build-contexts: \|\n\s+engine=lyrashield-engine/)
  assert.match(prodWorker.body, /build-contexts: \|\n\s+engine=lyrashield-engine/)
  assert.match(job, /repository: \$\{\{ github\.repository_owner \}\}\/lyrashield-engine/)
  assert.match(job, /ref: \$\{\{ steps\.engine\.outputs\.revision \}\}/)
  // The PR gate reads the same immutable pin the release workflow declares.
  assert.match(
    job,
    /sed -nE 's\/\^  ENGINE_REVISION: \(\[0-9a-f\]\{40\}\)\$\/\\1\/p' \.github\/workflows\/deploy-azure\.yml/
  )
  assert.match(release, /^  ENGINE_REVISION: [0-9a-f]{40}$/m)
})

test("PR container job is credential-free and never runs under pull_request_target", () => {
  const triggers = workflow.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1] ?? ""
  assert.match(triggers, /^  pull_request:/m)
  assert.doesNotMatch(triggers, /^  pull_request_target:/m)
  const job = jobSection(workflow, "container-build")
  const permissions = job.match(/^    permissions:\n((?:      .*\n)+)/m)?.[1] ?? ""
  assert.match(permissions, /^      contents: read$/m)
  for (const scope of permissions.trim().split("\n")) {
    assert.match(scope.trim(), /^contents: read$/, `unexpected permission scope: ${scope}`)
  }
  assert.doesNotMatch(job, /id-token|environment:|secrets\.(?!GITHUB_TOKEN)/)
})

test("a broken Dockerfile fails the same check the PR gate runs", (t) => {
  const probe = spawnSync("docker", ["buildx", "version"], { encoding: "utf8" })
  if (probe.status !== 0) {
    if (process.env.CI === "true") {
      assert.fail("CI runners ship docker buildx; the container gate proof cannot be skipped")
    }
    t.skip("docker buildx is unavailable outside CI")
    return
  }

  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-docker-gate-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const engineContext = path.join(directory, "engine")
  mkdirSync(engineContext)

  // The checked-in Dockerfile must still parse cleanly under the same check,
  // with the named engine context bound exactly like the build steps do.
  const good = spawnSync(
    "docker",
    ["buildx", "build", "--check", "--build-context", `engine=${engineContext}`, "."],
    { encoding: "utf8" }
  )
  assert.equal(good.status, 0, good.stderr)

  const broken = path.join(directory, "Dockerfile.broken")
  writeFileSync(broken, "FROM scratch\nBROKEN_INSTRUCTION foo\n")
  const failed = spawnSync("docker", ["buildx", "build", "--check", "-f", broken, "."], {
    encoding: "utf8",
  })
  assert.notEqual(failed.status, 0, "docker build --check must fail a broken Dockerfile")
  assert.match(`${failed.stdout}${failed.stderr}`, /BROKEN_INSTRUCTION|parse error/i)
})
