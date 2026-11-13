/* eslint-disable security/detect-non-literal-fs-filename -- All paths are repository constants or confined to a test-owned mkdtemp fixture. */
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const workflow = readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8")
const quality = workflow.split("\n  code-quality:\n")[1].split("\n  app-checks:\n")[0]
const schema = readFileSync(path.join(repository, "packages/config/src/env.ts"), "utf8")

for (const [name, paths] of [
  ["web-only", ["apps/web/src/lib/turnstile.ts"]],
  ["worker-only", ["apps/worker/src/index.ts"]],
  ["package-only", ["packages/config/src/env.ts"]],
  [
    "mixed runtime/tooling",
    [
      "apps/web/src/lib/turnstile.ts",
      "packages/config/src/env.ts",
      ".github/scripts/tests/ci-selection.test.mjs",
    ],
  ],
  ["tooling-only", [".github/scripts/tests/ci-selection.test.mjs"]],
]) {
  test(`actual CI ownership audit is reached and rejects an unowned literal for ${name}`, (t) => {
    const classified = execFileSync(
      "bash",
      [path.join(repository, ".github/scripts/classify-paths.sh")],
      {
        input: paths.join("\n") + "\n",
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
      }
    )
    const flags = Object.fromEntries(
      classified
        .trim()
        .split("\n")
        .map((line) => line.split("="))
    )
    assert.ok(flags.app === "true" || flags.shared === "true" || flags["tooling-only"] === "true")
    if (name !== "tooling-only") assert.equal(flags["tooling-only"], "false")
    else assert.equal(flags["tooling-only"], "true")
    // Evaluate the real job/step expressions against the real classifier output.
    const selected = (body) => {
      const condition = /^    (?:    )?if: (.+)$/m.exec(body)?.[1]
      if (!condition) return true
      const expression = condition.replace(/needs\.changes\.outputs\.([\w-]+)/g, (_, key) => {
        assert.ok(key in flags, `unknown routing flag ${key}`)
        return JSON.stringify(flags[key])
      })
      return runInNewContext(expression, {}, { timeout: 100 })
    }
    assert.equal(selected(quality.split("\n    steps:\n")[0]), true)
    const step = quality
      .split("      - name: Runtime environment ownership audit\n")[1]
      ?.split("\n      - name:")[0]
    assert.ok(step, "code-quality must declare its own ownership audit step")
    assert.equal(selected(step), true, `ownership audit must run for ${name}`)
    const run = /^        run: (.+)$/m.exec(step)?.[1]
    assert.equal(run, "pnpm lint:env-ownership")
    assert.equal((quality.match(/pnpm lint:env-ownership/g) ?? []).length, 1)

    // Run that exact workflow command against a tiny tracked-source fixture,
    // using the real CLI, central schema and ownership exceptions.
    const directory = mkdtempSync(path.join(tmpdir(), "lyra-env-ci-"))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    mkdirSync(path.join(directory, "lint"), { recursive: true })
    mkdirSync(path.join(directory, "packages/config/src"), { recursive: true })
    copyFileSync(
      path.join(repository, "lint/env-ownership.mjs"),
      path.join(directory, "lint/env-ownership.mjs")
    )
    writeFileSync(path.join(directory, "packages/config/src/env.ts"), schema)
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ scripts: { "lint:env-ownership": "node lint/env-ownership.mjs" } })
    )
    const sourcePath =
      paths.find((file) => /^(apps|packages)\//.test(file)) ?? "apps/web/src/lib/tooling-probe.ts"
    const file = path.join(directory, sourcePath)
    mkdirSync(path.dirname(file), { recursive: true })
    const prefix = sourcePath === "packages/config/src/env.ts" ? schema : ""
    writeFileSync(file, prefix + "\nexport const probe = process.env.NEXT_PUBLIC_MARKETING_URL\n")
    execFileSync("git", ["init", "-q", directory])
    execFileSync("git", ["-C", directory, "add", "."])
    const execute = () =>
      spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
        cwd: directory,
        encoding: "utf8",
        timeout: 15_000,
      })
    const accepted = execute()
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
    writeFileSync(file, prefix + "\nexport const probe = process.env.TASK11_UNOWNED_PROBE\n")
    const rejected = execute()
    assert.notEqual(rejected.status, 0)
    assert.match(
      rejected.stdout + rejected.stderr,
      /TASK11_UNOWNED_PROBE needs a central schema field or an exact external owner/
    )
  })
}
