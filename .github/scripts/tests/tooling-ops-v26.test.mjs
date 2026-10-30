import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
const read = (name) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8")

test("deployment jobs bound runtime by responsibility", () => {
  for (const name of ["deploy-azure.yml", "deploy-azure-runtime.yml"]) {
    const source = read(`.github/workflows/${name}`)
    for (const [, job, body] of source.matchAll(
      /^  ([a-z][\w-]*):\n([\s\S]*?)(?=^  [a-z][\w-]*:|$(?![\s\S]))/gm
    )) {
      if (!body.includes("    runs-on:")) continue
      const minutes = /    timeout-minutes: (\d+)/.exec(body)?.[1]
      const expected =
        job === "build" || job === "prepare-dependencies" ? "60" : job === "deploy" ? "45" : "15"
      assert.equal(minutes, expected, `${name}/${job}`)
    }
  }
})

test("CSS and marketing edits select their narrow source contracts", () => {
  const source = read(".github/workflows/ci.yml")
  assert.match(
    source,
    /name: Web presentation contracts\n        if: needs.changes.outputs.app == 'true'[\s\S]*?vitest run --maxWorkers=2 apps\/web\/src\/app\/mobile-shell.contract.test.ts/
  )
  assert.match(
    source,
    /name: Marketing deployment source contract\n        if: needs.changes.outputs.marketing-tests == 'true'[\s\S]*?node --test .github\/scripts\/tests\/marketing-deploy-smoke.test.mjs/
  )
  assert.match(
    source,
    /TARGET_ADMISSION_RUNTIME_TEST=1[\s\S]*?target-admission.runtime.test.ts[\s\S]*?assert-named-vitest-tests/
  )
})

test("cleanup warning and secret-removal failure have separate policy IDs", () => {
  const source = read(".github/workflows/deploy-azure-runtime.yml")
  assert.match(
    source,
    /name: Deactivate superseded Container App revisions\n        id: revision-cleanup\n        continue-on-error: true/
  )
  assert.match(source, /name: Remove excess scanner secrets\n        id: scanner-secret-removal/)
  assert.doesNotMatch(source, /remove-excess-scanner-secrets \|\| echo/)
  assert.match(source, /scanner-secret-removal.outcome == 'failure'/)
})

test("backup and restore keep credentials out of command arguments and bind loopback by default", () => {
  const source = read(".github/workflows/production-backup.yml")
  assert.match(source, /export PG_URL="\$pg_dump_url"/)
  assert.match(source, /--env PG_URL \\\n/)
  assert.doesNotMatch(source, /--env PG_URL=/)
  assert.doesNotMatch(
    source,
    /POSTGRES_PASSWORD=restore|restore:restore@|cat "\$RUNNER_TEMP\/restore-web.log"/
  )
  assert.match(source, /\$\{ISOLATED_RESTORE_BIND:-127\.0\.0\.1:\}5433:5432/)
  assert.match(source, /\$\{ISOLATED_RESTORE_BIND:-127\.0\.0\.1:\}6379:6379/)
})
