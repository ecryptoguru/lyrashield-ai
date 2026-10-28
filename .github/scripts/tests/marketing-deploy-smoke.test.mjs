import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const workflow = readFileSync(".github/workflows/deploy-marketing.yml", "utf8")
const step = workflow.split("- name: Assert the live homepage is the build we just shipped")[1]
const script = step
  .split("        run: |\n")[1]
  .split("\n      - name:")[0]
  .split("\n")
  .map((line) => line.replace(/^          /, ""))
  .join("\n")
const markers = [...script.matchAll(/'data-cta-id="([^"]+)"'/g)].map((match) =>
  match[0].slice(1, -1)
)
const revision = "a".repeat(40)
const markup = (sha = revision, features = markers) =>
  `<meta name="lyrashield-build-revision" content="${sha}">${features.join(" ")}${"x".repeat(300000)}`

function run(html) {
  const dir = mkdtempSync(join(tmpdir(), "marketing-smoke-"))
  try {
    writeFileSync(join(dir, "homepage"), html)
    writeFileSync(join(dir, "curl"), '#!/bin/sh\ncat "$SMOKE_FIXTURE"\n', { mode: 0o755 })
    writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        SOURCE_SHA: revision,
        SMOKE_FIXTURE: join(dir, "homepage"),
      },
      encoding: "utf8",
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("deployment markers exist in the current homepage components", () => {
  assert.equal(markers.length, 2)
  const sources = ["PremiumHero", "FinalCta"]
    .map((name) => readFileSync(`apps/marketing/src/components/landing/${name}.astro`, "utf8"))
    .join("\n")
  for (const marker of markers)
    assert.ok(sources.includes(marker), `Retired smoke marker: ${marker}`)
})
test("matching revision and features pass with a large response under pipefail", () => {
  const result = run(markup())
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
test("stale revision fails even when features exist", () => {
  assert.equal(run(markup("b".repeat(40))).status, 1)
})
for (const marker of markers) {
  test(`missing ${marker} fails despite a matching revision`, () => {
    assert.equal(
      run(
        markup(
          revision,
          markers.filter((value) => value !== marker)
        )
      ).status,
      1
    )
  })
}
