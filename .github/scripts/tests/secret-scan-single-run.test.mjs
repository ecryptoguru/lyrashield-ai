import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// A4: gitleaks-action ran twice on the same pull-request diff — once in the
// required "SCA & Secret Scan" job in ci.yml and once in the dogfood diff gate
// in lyrashield-scan.yml, each with its own full-history checkout. The required
// job stays authoritative for this repository's pull requests. The reusable
// workflow keeps the scan for workflow_call consumers, which are other
// repositories and other events.
const ci = readFileSync(new URL("../../workflows/ci.yml", import.meta.url), "utf8")
const scan = readFileSync(new URL("../../workflows/lyrashield-scan.yml", import.meta.url), "utf8")

const suppression =
  /if: \$\{\{ !\(github\.event_name == 'pull_request' && github\.repository == 'ecryptoguru\/lyrashield-ai'\) \}\}/
const suppressionLine =
  "        if: ${{ !(github.event_name == 'pull_request' && github.repository == 'ecryptoguru/lyrashield-ai') }}"

function gitleaksSteps(source) {
  const blocks = []
  for (const match of source.matchAll(/^ {6}- name: .+$/gm)) {
    const rest = source.slice(match.index)
    const next = rest.slice(1).search(/\n {6}- name: /)
    const block = next < 0 ? rest : rest.slice(0, next + 1)
    if (/uses: gitleaks\/gitleaks-action@[0-9a-f]{40}/.test(block)) blocks.push(block)
  }
  return blocks
}

test("the required security job keeps the authoritative per-PR secret scan", () => {
  const blocks = gitleaksSteps(ci)
  assert.equal(blocks.length, 1, "ci.yml keeps exactly one gitleaks step")
  const block = blocks[0]
  assert.doesNotMatch(block, /^ {8}if:/m, "the required scan must run on every pull request")
  assert.doesNotMatch(block, /continue-on-error/, "a secret finding must fail the required check")
})

test("the dogfood diff gate suppresses only its duplicate scan on this repo's PRs", () => {
  const blocks = gitleaksSteps(scan)
  assert.equal(blocks.length, 1, "lyrashield-scan.yml keeps exactly one gitleaks step")
  assert.ok(
    blocks[0].split("\n").includes(suppressionLine),
    "the duplicate must be suppressed for this repository's pull_request runs only"
  )
})

test("the reusable workflow stays a complete diff gate for its callers", () => {
  // workflow_call runs report github.event_name == 'workflow_call', and a
  // consumer's own pull_request run reports the consumer's repository, so both
  // keep the secret scan. Nothing else about the gate may be weakened.
  assert.match(scan, /^ {2}workflow_call:$/m)
  assert.match(scan, /^ {2}pull_request:$/m, "the dogfood trigger stays for the rest of the gate")
  assert.match(scan, /^ {4}name: Security Scan \(diff-gate\)$/m)
  assert.match(scan, /^ {4}timeout-minutes: 15$/m)
  assert.match(
    scan,
    /GITLEAKS_LOG_OPTS: \$\{\{ steps\.diff\.outputs\.base_sha \}\}\.\.\$\{\{ steps\.diff\.outputs\.head_sha \}\}/
  )
  assert.match(scan, /- name: Diff-gate decision/)
})

test("this repository's pull request reaches exactly one gitleaks invocation", () => {
  const runsHere = (blocks) => blocks.filter((block) => !suppression.test(block)).length
  assert.equal(
    runsHere(gitleaksSteps(ci)) + runsHere(gitleaksSteps(scan)),
    1,
    "one gitleaks invocation per pull request in this repository, not two"
  )
})

test("the reusable workflow's in-repo callers are unchanged", () => {
  assert.doesNotMatch(ci, /uses: .\/\.github\/workflows\/lyrashield-scan\.yml/)
})
