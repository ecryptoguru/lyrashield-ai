/* eslint-disable security/detect-non-literal-fs-filename -- Read-only local qualification uses an operator-supplied fixture directory. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseEngineOutput } from "../apps/worker/src/engine/output-parser"

// Read exact engine-emitted bytes, not a JSON-reserialized approximation. The
// generator's summary is an integrity receipt; expected semantics stay here.
const fixtureRoot = process.argv[2]
assert(fixtureRoot, "Pass the generated writer fixture directory")
const summary = JSON.parse(readFileSync(join(fixtureRoot, "summary.json"), "utf8"))
const ids = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => String(start + i))
const cases = [
  { name: "reverse-reuse", ordinary: [["18"]], pending: [["17"]], captured: 1 },
  {
    name: "shared-capacity",
    ordinary: [ids(1, 10), ["99"]],
    pending: [["99"], []],
    captured: 11,
  },
  { name: "overflow-failed", ordinary: [[]], pending: [ids(20, 10)], captured: 0 },
  { name: "header-bound", ordinary: [["17"]], pending: [[]], captured: 1 },
  {
    name: "max-bytes",
    ordinary: [ids(1, 10), ids(11, 10), ids(21, 10), [], [], [], []],
    pending: [[], [], [], ids(31, 10), ids(41, 10), ids(51, 10), ids(61, 4)],
    captured: 30,
  },
  ...["outcome-missing", "outcome-capacity", "doc-missing", "doc-capacity", "doc-truncated"].map(
    (name) => ({ name, ordinary: [[]], pending: [["17"]], captured: 0 })
  ),
  { name: "negative-with-prior", ordinary: [["17"]], pending: [[]], captured: 1 },
  { name: "deadline-late", ordinary: [[]], pending: [["17"]], captured: 0 },
  {
    name: "omission-limit",
    ordinary: Array.from({ length: 56 }, () => []),
    pending: Array.from({ length: 56 }, (_, index) => ids(index * 10 + 1, 10)),
    captured: 0,
  },
]
assert.deepEqual(Object.keys(summary).sort(), cases.map((c) => c.name).sort())

for (const [index, outcome] of cases.entries()) {
  const { name } = outcome
  const receipt = summary[name]
  assert(receipt, `${name}: missing summary receipt`)
  const expectsHttp = name !== "overflow-failed" && name !== "omission-limit"
  const tupleFiles = [
    "run.json",
    "vulnerabilities.json",
    ...(expectsHttp ? ["http_exchanges.json"] : []),
  ]
  assert.deepEqual(
    Object.keys(receipt.files).sort(),
    [...tupleFiles].sort(),
    `${name}: tuple files`
  )
  assert.equal(
    existsSync(join(fixtureRoot, name, "http_exchanges.json")),
    expectsHttp,
    `${name}: HTTP artifact presence`
  )
  const verified = new Map<string, Buffer>()
  for (const file of tupleFiles) {
    const identity = receipt.files[file] as { bytes: number; sha256: string }
    const raw = readFileSync(join(fixtureRoot, name, file))
    assert.equal(raw.length, identity.bytes, `${name}/${file}: byte length`)
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      identity.sha256,
      `${name}/${file}: SHA-256`
    )
    verified.set(file, raw)
  }
  // Parsing uses only the buffers whose byte length and digest were verified.
  const read = (file: string) => verified.get(file)?.toString("utf8")
  const httpRaw = read("http_exchanges.json")
  const result = parseEngineOutput(
    read("vulnerabilities.json")!,
    read("run.json")!,
    { httpExchangesRaw: httpRaw },
    { expectedRunName: `task5-${index < 5 ? "fix1" : "fix2"}-${name}` }
  )
  assert.equal(result.findingsComplete, true, `${name}: complete findings`)
  assert.deepEqual(
    result.vulnerabilities.map((v) => v.http_exchange_ids ?? []),
    outcome.ordinary
  )
  assert.deepEqual(
    result.vulnerabilities.map((v) => v.pending_http_exchange_ids ?? []),
    outcome.pending
  )
  assert(result.vulnerabilities.every((v) => v.engine_verification_state === "unverified"))
  if (outcome.captured === 0) {
    assert.equal(result.httpExchangeExport, null)
    if (name === "overflow-failed" || name === "omission-limit") {
      assert.equal(httpRaw, undefined, `${name}: failed export has no HTTP artifact`)
    } else {
      assert(httpRaw, `${name}: failed export's empty artifact must be quarantined`)
      assert(result.ingestionIssues.length > 0)
    }
    if (name === "overflow-failed") {
      assert.equal(result.vulnerabilities[0]?.http_exchange_refs_dropped, true)
      assert(result.ingestionIssues.length > 0)
    }
  } else {
    assert.equal(result.httpExchangeExport?.knownIds.size, outcome.captured)
    assert.deepEqual(result.ingestionIssues, [], `${name}: qualified envelope`)
  }
  console.log(`${name}: PASS (${outcome.captured} captured; pending claims remain unverified)`)
}
