import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import {
  routingFlags,
  validateRouting,
  validateResults,
  workspaceFilters,
} from "../ci-selection.mjs"
import { assertFileCounts } from "../assert-vitest-file-counts.mjs"

const require = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)
const { parse } = require("yaml")
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"))
function classify(...paths) {
  const receipt = execFileSync("bash", [".github/scripts/classify-paths.sh"], {
    input: paths.join("\n"),
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "" },
  })
  return validateRouting(
    Object.fromEntries(
      receipt
        .trim()
        .split("\n")
        .map((line) => line.split("="))
    )
  )
}
function results(outputs = classify("README.md")) {
  return {
    changes: { result: "success", outputs },
    "code-quality": { result: "success" },
    "app-checks": {
      result:
        outputs.app === "true" ||
        (outputs.shared === "true" && outputs["tooling-only"] !== "true") ||
        outputs["database-tests"] === "true" ||
        outputs["database-services"] === "true" ||
        outputs["ops-tests"] === "true"
          ? "success"
          : "skipped",
    },
    "desktop-frontend": {
      result: outputs["desktop-frontend-tests"] === "true" ? "success" : "skipped",
    },
    "marketing-checks": {
      result:
        outputs["marketing-tests"] === "true" || outputs["motion-tests"] === "true"
          ? "success"
          : "skipped",
    },
  }
}

test("routing validates every required boolean and rejects absent/corrupt receipts", () => {
  for (const name of routingFlags) {
    for (const bad of [undefined, "", "TRUE", "0", true]) {
      const receipt = { ...classify("README.md"), [name]: bad }
      assert.throws(
        () => validateRouting(receipt),
        (error) => error.message.includes(name)
      )
    }
  }
  assert.throws(() => validateRouting(null))
  assert.throws(
    () => validateRouting({ ...classify("README.md"), "database-tests": "true" }),
    /services/
  )
  for (const flag of routingFlags)
    assert.equal(workflow.jobs.changes.outputs[flag], `\${{ steps.classify.outputs.${flag} }}`)
})

test("aggregate rejects every failed, skipped, missing or cancelled selected dependency", () => {
  assert.throws(() => validateResults(null), /unavailable/)
  for (const paths of [
    ["README.md"],
    ["apps/marketing/src/pages/index.astro"],
    ["unknown-input"],
  ]) {
    const needs = results(classify(...paths))
    assert.doesNotThrow(() => validateResults(needs))
    assert.throws(() => validateResults(needs, true), /cancelled/)
    for (const status of ["failure", "cancelled", "skipped", "", undefined]) {
      assert.throws(() =>
        validateResults({ ...needs, changes: { ...needs.changes, result: status } })
      )
      assert.throws(() => validateResults({ ...needs, "code-quality": { result: status } }))
      if (needs["app-checks"].result === "success" || status !== "skipped")
        assert.throws(() => validateResults({ ...needs, "app-checks": { result: status } }))
      if (needs["marketing-checks"].result === "success") {
        assert.throws(() => validateResults({ ...needs, "marketing-checks": { result: status } }))
      }
    }
    if (needs["desktop-frontend"].result === "success") {
      assert.throws(() => validateResults({ ...needs, "desktop-frontend": { result: "skipped" } }))
    }
    for (const status of ["failure", "cancelled", "", undefined]) {
      assert.throws(() => validateResults({ ...needs, "desktop-frontend": { result: status } }))
    }
    for (const flag of routingFlags) {
      assert.throws(() =>
        validateResults({
          ...needs,
          changes: { result: "success", outputs: { ...needs.changes.outputs, [flag]: undefined } },
        })
      )
    }
  }
  const aggregate = workflow.jobs["lint-and-typecheck"]
  assert.equal(aggregate.name, "Lint, Typecheck, Test & Build")
  assert.equal(aggregate.if, "${{ always() }}")
  assert.deepEqual(aggregate.needs, [
    "changes",
    "code-quality",
    "app-checks",
    "marketing-checks",
    "desktop-frontend",
  ])
  assert.equal(aggregate.steps.at(-1).if, "${{ cancelled() }}")
  const check = aggregate.steps.find((step) => step.run?.includes("ci-selection.mjs results"))
  assert.equal(check.if, "${{ always() && !cancelled() }}")
  assert.equal(check.env.CI_NEEDS, "${{ toJSON(needs) }}")
})

test("only web CSS and public assets narrow runtime gates; mixed, renamed and server paths stay broad", () => {
  for (const file of ["apps/web/src/app/globals.css", "apps/web/public/logo.webp"]) {
    const receipt = classify(file)
    assert.equal(receipt.app, "true")
    assert.equal(receipt["database-tests"], "false")
    assert.equal(receipt["engine-worker-contract"], "false")
    assert.equal(receipt["web-image"], "true")
    assert.equal(receipt["worker-image"], "false")
    assert.equal(receipt["egress-image"], "false")
    for (const mixed of [
      "apps/web/src/app/api/scans/route.ts",
      "apps/web/src/lib/auth.ts",
      "apps/web/public/runtime.js",
      "apps/web/public/config.json",
      "packages/billing/src/index.ts",
      "apps/worker/src/index.ts",
      "unclassified-new-input",
    ]) {
      assert.equal(classify(file, mixed)["database-tests"], "true")
    }
  }
  // A rename supplies both paths through git diff --no-renames; deleted paths
  // are classified without consulting the current filesystem.
  assert.equal(classify("apps/worker/removed.ts", "docs/moved.md")["worker-image"], "true")
  assert.equal(classify("apps/web/src/app/page.tsx")["database-tests"], "true")
  for (const name of [
    "Lint",
    "Typecheck",
    "Build app and shared packages",
    "Typecheck portable browser harness",
    "Lint portable browser harness",
    "Cache Playwright browser",
    "Install Playwright browser",
    "Portable browser harness",
  ]) {
    const step = [
      ...workflow.jobs["app-checks"].steps,
      ...workflow.jobs["code-quality"].steps,
    ].find((step) => step.name === name)
    assert.ok(step.if.includes("needs.changes.outputs.app == 'true'"), name)
  }
  assert.equal(classify("apps/web/src/app/api/billing/route.ts")["database-tests"], "true")
  assert.equal(classify("packages/db/prisma/schema.prisma")["database-tests"], "true")
  assert.equal(classify("apps/desktop/src-tauri/src/main.rs").desktop, "true")
  for (const file of ["packages/types/src/fixtures/scan-depths.json", "pnpm-lock.yaml", ".nvmrc"])
    assert.equal(classify(file)["desktop-frontend-tests"], "true", file)
  assert.equal(classify("packages/billing/src/index.ts")["desktop-frontend-tests"], "false")
  for (const file of [
    ".nvmrc",
    ".python-version",
    ".prettierrc.json",
    ".prettierignore",
    ".editorconfig",
  ]) {
    assert.equal(classify(file)["docs-only"], "false", file)
    assert.equal(classify(file)["database-tests"], "true", file)
  }
  for (const file of ["docs/marketplace/openclaw/SKILL.md", "docs/marketplace/assets/logo.png"]) {
    assert.equal(classify(file)["docs-only"], "false", file)
    assert.equal(classify(file).shared, "true", file)
    assert.equal(classify(file)["azure-deploy"], "false", file)
  }
})

test("image selection retains all shared/unknown/root build inputs and narrows app-local changes", () => {
  for (const file of [
    "Dockerfile",
    "pnpm-lock.yaml",
    "packages/db/prisma/schema.prisma",
    "unknown-file",
  ]) {
    for (const flag of ["web-image", "worker-image", "egress-image"])
      assert.equal(classify(file)[flag], "true")
  }
  assert.equal(classify("apps/worker/src/index.ts")["web-image"], "false")
  assert.equal(classify("apps/worker/src/index.ts")["worker-image"], "true")
  const container = workflow.jobs["container-build"]
  for (const [name, flag] of [
    ["web", "web-image"],
    ["worker", "worker-image"],
    ["egress-proxy", "egress-image"],
  ]) {
    const step = container.steps.find((step) => step.name === `Build ${name} image (no push)`)
    assert.equal(step.if, `needs.changes.outputs.${flag} == 'true'`)
    assert.equal(step.with.push, false)
  }
})

test("Turbo task graphs retain dependencies and SDK/MCP/plugin prerequisites without unrelated applications", () => {
  function graph(outputs, group, task) {
    const filters = workspaceFilters(outputs, group, task)
    assert.ok(filters.length)
    return JSON.parse(
      execFileSync("pnpm", ["exec", "turbo", "run", task, ...filters, "--dry=json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    )
  }
  const web = graph(classify("apps/web/src/app/page.tsx"), "app", "typecheck")
  assert.ok(web.tasks.some((task) => task.taskId === "@lyrashield/web#typecheck"))
  for (const packageName of [
    "@lyrashield/marketing",
    "@lyrashield/marketing-motion",
    "@lyrashield/desktop-frontend",
    "@lyrashield/worker",
  ])
    assert.ok(!web.packages.includes(packageName), packageName)
  assert.ok(web.tasks.some((task) => task.taskId === "@lyrashield/db#generate"))
  for (const source of ["apps/web/src/app/page.tsx", "apps/worker/src/index.ts"]) {
    const runtime = graph(classify(source), "app", "typecheck")
    for (const taskId of [
      "@lyrashield/sdk#build",
      "@lyrashield/mcp#build",
      "@lyrashield/agent-plugin#build",
    ])
      assert.ok(
        runtime.tasks.some((task) => task.taskId === taskId),
        `${source}: ${taskId}`
      )
  }
  const presentation = graph(classify("apps/web/src/app/globals.css"), "app", "typecheck")
  assert.ok(!presentation.packages.includes("@lyrashield/agent-plugin"))
  const shared = graph(classify("packages/billing/src/index.ts"), "app", "typecheck")
  for (const taskId of [
    "@lyrashield/sdk#build",
    "@lyrashield/mcp#build",
    "@lyrashield/agent-plugin#build",
    "lyrashield#typecheck",
  ])
    assert.ok(
      shared.tasks.some((task) => task.taskId === taskId),
      taskId
    )
  const marketing = graph(
    classify("apps/marketing/src/pages/index.astro"),
    "marketing",
    "typecheck"
  )
  assert.ok(marketing.packages.includes("@lyrashield/security"))
  assert.ok(marketing.tasks.some((task) => task.taskId === "@lyrashield/db#generate"))
  assert.ok(!marketing.packages.includes("@lyrashield/web"))
  assert.deepEqual(workspaceFilters(classify("README.md"), "marketing"), [])
  assert.throws(() => workspaceFilters(classify("README.md"), "typo"))
})

test("retained built-app browser proofs select an executable web build for worker-only changes", () => {
  const appSteps = workflow.jobs["app-checks"].steps
  const browser = appSteps.find((step) => step.name.startsWith("Browser E2E ("))
  const build = appSteps.find((step) => step.name === "Build app and shared packages")
  const portable = appSteps.find((step) => step.name === "Portable browser harness")
  assert.equal(build.run, "node .github/scripts/ci-selection.mjs build app")
  function selected(step, outputs) {
    const expression = step.if.replace(/needs\.changes\.outputs\.([\w-]+)/g, (_, key) => {
      assert.ok(key in outputs, `Unknown routing output: ${key}`)
      return JSON.stringify(outputs[key])
    })
    return runInNewContext(expression, {}, { timeout: 100 })
  }
  for (const [source, builtBrowserSelected] of [
    ["apps/worker/src/index.ts", true],
    ["apps/web/src/app/api/scans/route.ts", true],
    ["packages/db/prisma/schema.prisma", true],
    ["unknown-runtime-input", true],
    ["apps/web/src/app/globals.css", false],
    ["apps/web/public/logo.webp", false],
  ]) {
    const outputs = classify(source)
    assert.equal(selected(browser, outputs), builtBrowserSelected, source)
    assert.equal(selected(portable, outputs), true, source)
    assert.equal(selected(build, outputs), true, source)
    const graph = JSON.parse(
      execFileSync(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          ...workspaceFilters(outputs, "app", "build"),
          "--dry=json",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
    )
    assert.ok(
      graph.tasks.some(
        (task) => task.taskId === "@lyrashield/web#build" && task.command !== "<NONEXISTENT>"
      ),
      `${source}: retained browser proof requires an executable web build`
    )
    for (const name of [
      "@lyrashield/marketing",
      "@lyrashield/marketing-motion",
      "@lyrashield/desktop-frontend",
    ]) {
      assert.ok(!graph.packages.includes(name), `${source}: unrelated ${name} build`)
    }
  }
  const worker = classify("apps/worker/src/index.ts")
  assert.equal(
    worker["web-image"],
    "false",
    "built-app test dependency must not select the web image"
  )
  assert.equal(worker["worker-image"], "true")
})

test("service integration proof rejects missing, skipped and undercounted fixtures", () => {
  const report = {
    testResults: [
      { name: "/repo/a.test.ts", assertionResults: [{ status: "passed" }, { status: "passed" }] },
    ],
  }
  assert.doesNotThrow(() => assertFileCounts(report, [["a.test.ts", 2]]))
  assert.throws(() => assertFileCounts(report, [["missing.ts", 1]]))
  assert.throws(() => assertFileCounts(report, [["a.test.ts", 3]]))
  const skipped = structuredClone(report)
  skipped.testResults[0].assertionResults[0].status = "pending"
  assert.throws(() => assertFileCounts(skipped, [["a.test.ts", 2]]))
})

test("code quality starts independently and owns every lint and typecheck gate", () => {
  const quality = workflow.jobs["code-quality"]
  assert.ok(quality, "missing independent code-quality job")
  assert.equal(quality.name, "Lint & Typecheck")
  assert.equal(quality.needs, "changes")
  assert.equal(quality.if, undefined)
  assert.ok(quality["timeout-minutes"] > 0)
  assert.equal(quality.services, undefined)
  assert.equal(quality.env.LYRASHIELD_TEST_DB_DISPOSABLE, "0")
  const app = workflow.jobs["app-checks"]
  assert.equal(app.needs, "changes")
  assert.ok(
    !app.steps.some((step) =>
      /^(Lint|Typecheck|Format check|Serial-comma|Size lint|Dead-code)/.test(step.name)
    )
  )
  for (const name of [
    "Format check",
    "Serial-comma copy ratchet",
    "Size lint ratchet",
    "Dead-code report (knip, non-blocking)",
    "Lint CI tooling",
    "Lint",
    "Typecheck",
    "Typecheck web tests",
    "Typecheck browser fixtures",
    "Typecheck portable browser harness",
    "Lint portable browser harness",
    "Lint selected marketing workspaces",
    "Typecheck selected marketing workspaces",
  ])
    assert.ok(
      quality.steps.some((step) => step.name === name),
      name
    )
  assert.ok(!quality.steps.some((step) => /docker run|migrate:deploy/.test(step.run)))
  const cacheKey = (job) => job.steps.find((step) => step.name === "Cache Turbo").with.key
  assert.notEqual(cacheKey(quality), cacheKey(app))
})

test("app job and aggregate agree on intentional skips for every path class", () => {
  for (const [path, expectedSelection] of [
    ["README.md", false],
    [".github/scripts/ci-selection.mjs", true],
    ["apps/marketing/src/pages/index.astro", false],
    ["apps/web/src/app/globals.css", true],
    ["apps/worker/src/index.ts", true],
    ["packages/billing/src/index.ts", true],
    ["unknown-input", true],
    ["apps/desktop/src-tauri/Cargo.lock", false],
  ]) {
    const outputs = classify(path)
    const expression = workflow.jobs["app-checks"].if.replace(
      /needs\.changes\.outputs\.([\w-]+)/g,
      (_, key) => JSON.stringify(outputs[key])
    )
    const selected = runInNewContext(expression, {}, { timeout: 100 })
    assert.equal(selected, expectedSelection, path)
    const needs = results(outputs)
    assert.equal(needs["app-checks"].result, selected ? "success" : "skipped", path)
    assert.doesNotThrow(() => validateResults(needs), path)
    assert.throws(
      () =>
        validateResults({ ...needs, "app-checks": { result: selected ? "skipped" : "success" } }),
      path
    )
    for (const result of ["failure", "cancelled", "skipped", undefined])
      assert.throws(() => validateResults({ ...needs, "code-quality": { result } }), path)
  }
})

test("core imports get canonical plugin build prerequisites on their own runner", () => {
  const steps = workflow.jobs["app-checks"].steps
  const prepare = steps.find((step) => step.name === "Build core test export prerequisites")
  assert.ok(prepare)
  assert.equal(prepare.if, "needs.changes.outputs.database-tests == 'true'")
  assert.equal(
    prepare.run,
    "pnpm exec turbo run build --filter=@lyrashield/agent-plugin... --concurrency=2"
  )
  assert.ok(
    steps.indexOf(prepare) < steps.findIndex((step) => step.name === "Test affected suites")
  )
  const graph = JSON.parse(
    execFileSync(
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=@lyrashield/agent-plugin...", "--dry=json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
  )
  for (const taskId of [
    "@lyrashield/sdk#build",
    "@lyrashield/mcp#build",
    "@lyrashield/agent-plugin#build",
  ])
    assert.ok(
      graph.tasks.some((task) => task.taskId === taskId && task.command !== "<NONEXISTENT>"),
      taskId
    )
  for (const name of [
    "@lyrashield/web",
    "@lyrashield/worker",
    "@lyrashield/marketing",
    "@lyrashield/desktop-frontend",
  ])
    assert.ok(!graph.packages.includes(name), name)
})

test("marketing runtime prepares Prisma independently of the quality runner", () => {
  const steps = workflow.jobs["marketing-checks"].steps
  const generate = steps.findIndex((step) => step.run === "pnpm db:generate")
  const tests = steps.findIndex((step) => ["Test marketing", "Test motion"].includes(step.name))
  assert.ok(generate >= 0, "marketing runtime needs its own generated Prisma client")
  assert.ok(tests > generate, "Prisma must be available before runtime imports")
})
