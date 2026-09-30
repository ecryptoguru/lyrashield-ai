import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"

const workflow = readFileSync(new URL("../../workflows/ci.yml", import.meta.url), "utf8")
const mainGapScript = new URL("../classify-main-change-gap.sh", import.meta.url)
const pathClassifier = new URL("../classify-paths.sh", import.meta.url)
const productionRelease = readFileSync(
  new URL("../../workflows/release-production.yml", import.meta.url),
  "utf8"
)
const steps = new Map(
  [...workflow.matchAll(/^      - name: (.+)\n        if: (.+)$/gm)].map((match) => [
    match[1],
    match[2],
  ])
)

function runs(name, paths) {
  const output = execFileSync("bash", [".github/scripts/classify-paths.sh"], {
    input: paths.join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "" },
  })
  const outputs = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("="))
  )
  assert.ok(steps.has(name), `Missing gated step: ${name}`)
  const expression = steps.get(name).replace(/needs\.changes\.outputs\.([\w-]+)/g, (_, key) => {
    assert.ok(key in outputs, `Unknown classifier output: ${key}`)
    return JSON.stringify(outputs[key])
  })
  return runInNewContext(expression, {}, { timeout: 100 })
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim()
}

function writeFile(repository, relativePath, contents) {
  const absolutePath = path.join(repository, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, contents)
}

function createMainGapFixture({
  pendingFile = "apps/web/src/pending-runtime-change.ts",
  renames = [],
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-main-gap-"))
  const repository = path.join(directory, "repo")
  const binaryDirectory = path.join(directory, "bin")
  const ghFixtureDirectory = path.join(directory, "gh-fixtures")
  mkdirSync(repository)
  mkdirSync(binaryDirectory)
  mkdirSync(ghFixtureDirectory)

  git(repository, "init", "-q", "-b", "main")
  git(repository, "config", "user.email", "ci-routing@example.invalid")
  git(repository, "config", "user.name", "CI routing fixture")
  writeFile(repository, "README.md", "Deployed baseline\n")
  for (const rename of renames) writeFile(repository, rename.from, "export const deployed = true\n")
  git(repository, "add", ".")
  git(repository, "commit", "-qm", "deployed baseline")
  const deployedSha = git(repository, "rev-parse", "HEAD")

  if (renames.length > 0) {
    for (const rename of renames) git(repository, "mv", rename.from, rename.to)
  } else {
    writeFile(repository, pendingFile, "export const pending = true\n")
  }
  git(repository, "add", ".")
  git(repository, "commit", "-qm", "runtime change awaiting deployment")
  const pendingSha = git(repository, "rev-parse", "HEAD")

  writeFile(repository, "README.md", "Deployed baseline\nFollow-up docs only\n")
  git(repository, "add", ".")
  git(repository, "commit", "-qm", "docs-only successor")
  const headSha = git(repository, "rev-parse", "HEAD")

  return {
    directory,
    repository,
    binaryDirectory,
    ghFixtureDirectory,
    deployedSha,
    pendingSha,
    headSha,
  }
}

function installCommand(directory, name, contents) {
  const file = path.join(directory, name)
  writeFileSync(file, contents)
  chmodSync(file, 0o755)
}

function runMainGap(
  fixture,
  { cloudflareSha, deployments, statuses, runs: runFixtures, latestMainSha }
) {
  const outputFile = path.join(fixture.directory, "github-output")
  const repositoryName = "example/lyrashield-ai"
  const writeJson = (name, value) =>
    writeFileSync(path.join(fixture.ghFixtureDirectory, name), JSON.stringify(value))

  writeJson("ref.json", { object: { sha: latestMainSha ?? fixture.headSha } })
  writeJson("deployments.json", deployments ?? [])
  for (const [id, value] of Object.entries(statuses ?? {})) writeJson(`statuses-${id}.json`, value)
  for (const [id, value] of Object.entries(runFixtures ?? {})) writeJson(`run-${id}.json`, value)

  installCommand(
    fixture.binaryDirectory,
    "gh",
    `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${2:-}"
case "$endpoint" in
  "repos/${repositoryName}/git/ref/heads/main") cat "$GH_FIXTURE_DIR/ref.json" ;;
  "repos/${repositoryName}/deployments?environment=azure-production&ref=main&per_page=100") cat "$GH_FIXTURE_DIR/deployments.json" ;;
  repos/${repositoryName}/deployments/*/statuses?per_page=100)
    id="\${endpoint#repos/${repositoryName}/deployments/}"
    id="\${id%%/*}"
    cat "$GH_FIXTURE_DIR/statuses-$id.json"
    ;;
  repos/${repositoryName}/actions/runs/*)
    id="\${endpoint##*/}"
    cat "$GH_FIXTURE_DIR/run-$id.json"
    ;;
  *) echo "Unexpected GitHub API request: $endpoint" >&2; exit 2 ;;
esac
`
  )
  installCommand(
    fixture.binaryDirectory,
    "curl",
    `#!/usr/bin/env bash
set -euo pipefail
printf '<meta name="lyrashield-build-revision" content="%s">' "$CF_DEPLOYED_SHA"
`
  )

  const result = spawnSync("bash", [mainGapScript.pathname], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binaryDirectory}:${process.env.PATH}`,
      GH_FIXTURE_DIR: fixture.ghFixtureDirectory,
      GH_TOKEN: "fixture-token-must-not-be-printed",
      GITHUB_REPOSITORY: repositoryName,
      GITHUB_WORKSPACE: fixture.repository,
      GITHUB_OUTPUT: outputFile,
      GITHUB_RUN_ID: "12345",
      HEAD_SHA: fixture.headSha,
      CLASSIFIER_SCRIPT: pathClassifier.pathname,
      CF_DEPLOYED_SHA: cloudflareSha,
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("="))
  )
  return { ...result, outputs }
}

function azureCodeReleaseFixture(id, sha, runId, pathName, conclusion = "success") {
  return {
    deployment: { id, sha, created_at: `2026-10-01T00:00:${String(id).padStart(2, "0")}Z` },
    statuses: [
      {
        state: "success",
        log_url: `https://github.com/example/lyrashield-ai/actions/runs/${runId}/job/55`,
      },
    ],
    run: { path: pathName, head_sha: sha, conclusion },
  }
}

function azureFixtures(entries) {
  return {
    deployments: entries.map(({ deployment }) => deployment),
    statuses: Object.fromEntries(
      entries.map(({ deployment, statuses }) => [deployment.id, statuses])
    ),
    runs: Object.fromEntries(
      entries.flatMap(({ statuses, run }) =>
        statuses.map((status) => [status.log_url.match(/\/runs\/(\d+)\//)[1], run])
      )
    ),
  }
}

const runtimeSteps = [
  "Migration drift check",
  "Run database migrations",
  "Prove metering and queue invariants with disposable services",
  "Trial integration tests (restricted runtime role)",
  "Agent operation workspace foreign key test",
  "Run required PostgreSQL regression tests",
  "Build app and shared packages",
  "Browser E2E (includes functional mobile shell at 390px)",
  "Portable browser harness",
]

test("known tooling retains executable operations checks without runtime suites", () => {
  const paths = [".github/workflows/ci.yml", "run-all-tests.mjs"]
  for (const name of ["Test affected suites", "Test Azure deployment and alert operations"]) {
    assert.equal(runs(name, paths), true, name)
  }
  for (const name of runtimeSteps) assert.equal(runs(name, paths), false, name)
})

test("runtime, mixed, dependency and unknown paths retain production regression gates", () => {
  for (const paths of [
    ["apps/worker/src/index.ts"],
    [".github/workflows/ci.yml", "apps/web/src/app/page.tsx"],
    ["pnpm-lock.yaml"],
    ["new-runtime-entrypoint.js"],
  ]) {
    for (const name of runtimeSteps) assert.equal(runs(name, paths), true, `${paths}: ${name}`)
  }
})

test("CI cancels superseded PRs without interrupting a main release verification", () => {
  const concurrency = workflow.match(/^concurrency:\n((?:  .*\n)+)/m)?.[1] ?? ""
  assert.match(concurrency, /^  group: ci-\$\{\{ github\.ref \}\}$/m)
  assert.match(
    concurrency,
    /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m
  )
  const classifyStep = workflow
    .split("- name: Classify changed files\n")[1]
    ?.split("\n      - name:")[0]
  assert.ok(classifyStep, "missing changed-path classifier step")
  assert.match(classifyStep, /classify-main-change-gap\.sh/)
  assert.match(classifyStep, /github\.event\.pull_request\.base\.sha/)
  assert.match(classifyStep, /github\.event\.pull_request\.head\.sha/)
  assert.match(classifyStep, /git diff --no-renames --name-only/)
  assert.match(
    workflow,
    /needs\.changes\.outputs\.current-main == 'true' && needs\.changes\.outputs\.marketing-deploy == 'true'/
  )
})

test("main change routing carries pending runtime changes across a docs-only successor", (t) => {
  const fixture = createMainGapFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const operation = azureCodeReleaseFixture(
    3,
    fixture.headSha,
    303,
    ".github/workflows/provision-platform-admins.yml"
  )
  const failedDeploy = azureCodeReleaseFixture(
    2,
    fixture.pendingSha,
    202,
    ".github/workflows/deploy-azure.yml",
    "failure"
  )
  const lastRelease = azureCodeReleaseFixture(
    1,
    fixture.deployedSha,
    101,
    ".github/workflows/release-production.yml"
  )
  const azure = azureFixtures([operation, failedDeploy, lastRelease])
  const result = runMainGap(fixture, {
    cloudflareSha: fixture.deployedSha,
    ...azure,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs["current-main"], "true")
  assert.equal(result.outputs["docs-only"], "false")
  assert.equal(result.outputs.app, "true")
  assert.equal(result.outputs["azure-deploy"], "true")
  assert.equal(result.outputs["marketing-deploy"], "false")
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fixture-token-must-not-be-printed/)
})

test("renames from app paths into documentation still route affected artifacts", (t) => {
  const fixture = createMainGapFixture({
    renames: [
      { from: "apps/web/src/renamed-out.ts", to: "web-change.md" },
      { from: "apps/marketing/src/pages/renamed-out.astro", to: "marketing-change.md" },
    ],
  })
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const release = azureCodeReleaseFixture(
    1,
    fixture.deployedSha,
    101,
    ".github/workflows/release-production.yml"
  )
  const result = runMainGap(fixture, {
    cloudflareSha: fixture.deployedSha,
    ...azureFixtures([release]),
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.app, "true")
  assert.equal(result.outputs.marketing, "true")
  assert.equal(result.outputs["azure-deploy"], "true")
  assert.equal(result.outputs["marketing-deploy"], "true")
})

test("main change routing is target-specific when Azure is current but marketing is behind", (t) => {
  const fixture = createMainGapFixture({ pendingFile: "apps/marketing/src/pages/pending.astro" })
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const latestRelease = azureCodeReleaseFixture(
    1,
    fixture.headSha,
    101,
    ".github/workflows/release-production.yml"
  )
  const azure = azureFixtures([latestRelease])
  const result = runMainGap(fixture, {
    cloudflareSha: fixture.deployedSha,
    ...azure,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs["azure-deploy"], "false")
  assert.equal(result.outputs["marketing-deploy"], "true")
  assert.equal(result.outputs.app, "false")
  assert.equal(result.outputs.marketing, "true")
})

test("main change routing fails closed when a deployed baseline cannot be proven", (t) => {
  const fixture = createMainGapFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const operationsOnly = azureCodeReleaseFixture(
    1,
    fixture.headSha,
    101,
    ".github/workflows/configure-cloud-billing-admission.yml"
  )
  const azure = azureFixtures([operationsOnly])
  const result = runMainGap(fixture, {
    cloudflareSha: "a".repeat(40),
    ...azure,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs["current-main"], "true")
  assert.equal(result.outputs["docs-only"], "false")
  assert.equal(result.outputs.app, "true")
  assert.equal(result.outputs.marketing, "true")
  assert.equal(result.outputs.desktop, "true")
  assert.equal(result.outputs.shared, "true")
  assert.equal(result.outputs["azure-deploy"], "true")
  assert.equal(result.outputs["marketing-deploy"], "true")
})

test("stale main runs retain validation but cannot route a production deployment", (t) => {
  const fixture = createMainGapFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const result = runMainGap(fixture, {
    cloudflareSha: fixture.deployedSha,
    latestMainSha: fixture.pendingSha,
    deployments: [],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs["current-main"], "false")
  assert.equal(result.outputs["docs-only"], "false")
  assert.equal(result.outputs.app, "true")
  assert.equal(result.outputs["azure-deploy"], "true")
  assert.equal(result.outputs["marketing-deploy"], "true")
})

test("automatic Azure release remains bound to the completed run's current-main SHA", () => {
  assert.match(
    productionRelease,
    /^  group: release-production-\$\{\{ github\.event\.workflow_run\.head_sha \}\}$/m
  )
  assert.match(productionRelease, /^  cancel-in-progress: false$/m)

  const currentMainCheck = productionRelease
    .split("- name: Confirm release source is current main\n")[1]
    ?.split("\n      - name:")[0]
  assert.ok(currentMainCheck, "missing current-main SHA check")
  assert.match(currentMainCheck, /gh api .*\/git\/ref\/heads\/main/)
  assert.match(currentMainCheck, /if \[ "\$HEAD_SHA" = "\$latest_main" \]/)
  assert.match(
    productionRelease,
    /if: needs\.routing\.outputs\.current-main == 'true' && needs\.routing\.outputs\.azure-deploy == 'true'/
  )
  assert.match(productionRelease, /source_sha: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
})

test("large advisory copy output reaches its notice without a broken pipe", () => {
  const body = workflow.match(
    /- name: Serial-comma copy scan \(advisory\)[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/
  )?.[1]
  assert.ok(body, "Missing advisory copy scan")
  const directory = mkdtempSync("/tmp/lyrashield-copy-scan-")
  try {
    const script = body
      .replace(/^          /gm, "")
      .replace(
        /hits=\$\(grep[\s\S]*?\|\| true\)/,
        'hits=$(for ((i=0; i<10000; i++)); do printf "fixture:%s: comment, and text\\n" "$i"; done)'
      )
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: `${directory}/summary` },
    })
    assert.equal(result.status, 1, "Candidates retain the advisory status")
    assert.match(result.stdout, /::notice::\s*10000 raw serial-comma candidate/)
    assert.equal(result.stdout.split("fixture:").length - 1, 20)
    assert.equal(result.stderr, "")
    assert.equal(readFileSync(`${directory}/summary`, "utf8").split("fixture:").length - 1, 10000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
