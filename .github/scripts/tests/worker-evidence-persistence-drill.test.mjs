import assert from "node:assert/strict"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  distinctFixture,
  legacy,
  qualifyFixture,
  readWriterFixtures,
  requireDisposable,
} from "../worker-evidence-persistence-drill.mjs"

const fixture = fileURLToPath(new URL("../fixtures/worker-evidence-distinct/", import.meta.url))
test("distinct writer fixture has separate independently bound owners, revisions and captures", () => {
  const f = distinctFixture(fixture)
  assert.deepEqual(f.row.ordinary, { "vuln-0001": ["71"], "vuln-0002": ["73"] })
  assert.deepEqual(f.row.pending, { "vuln-0001": ["72"], "vuln-0002": ["72"] })
  const exp = JSON.parse(f.bytes["http_exchanges.json"])
  assert.deepEqual(exp.binding.finding_revisions, { "vuln-0001": 1, "vuln-0002": 0 })
})
test("fixture byte drift fails before reading product services", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-receipt-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(fixture, root, { recursive: true })
  writeFileSync(join(root, "vulnerabilities.json"), "[]")
  assert.throws(() => distinctFixture(root))
})
test("normalization cannot promote a foreign owner's reference onto the survivor", () => {
  const f = distinctFixture(fixture)
  const raw = JSON.parse(f.bytes["vulnerabilities.json"])
  const deps = {
    parseEngineOutput: () => ({ runRecord: {}, vulnerabilities: raw }),
    generateDedupeKey: () => "same-key",
    filterFalsePositives: (values) => values,
    normalizeFindings: (values) => [{ ...values[0], dedupeKey: "same-key" }],
  }
  assert.deepEqual(
    qualifyFixture(f, deps).discarded.map((v) => v.id),
    ["vuln-0002"]
  )
  assert.throws(
    () =>
      qualifyFixture(f, {
        ...deps,
        normalizeFindings: (values) => [
          {
            ...values[0],
            dedupeKey: "same-key",
            http_exchange_ids: values[1].http_exchange_ids,
          },
        ],
      }),
    /changed winning owner's/
  )
})
test("new legacy fixtures have independent launch-compatible identities", () => {
  for (const version of ["1.0", "1.1"]) {
    const f = legacy(version)
    const run = JSON.parse(f.bytes["run.json"])
    assert.equal(run.run_id, f.id)
    assert.equal(run.run_name, f.id)
    assert.equal(run.schema_version, version === "1.1" ? version : undefined)
  }
})
test("only the exact disposable endpoints and expected image identity are admitted", () => {
  const env = {
    LYRASHIELD_TEST_DB_DISPOSABLE: "1",
    NODE_ENV: "test",
    LYRASHIELD_PRODUCT_REVISION: "ed84ce06889e6a9c047db220fcabfa0c643200ad",
    LYRASHIELD_ENGINE_REVISION: "3001517530300ca5f602536bfadcbd3c95ad3039",
    LYRASHIELD_WORKER_IMAGE_DIGEST:
      "sha256:0c91d2a9dd91cfaa9a35ed9742aa118015a5deba8af324c1996d95d050442d5d",
    LYRASHIELD_ENGINE_PATH: "/fixture-bin/drill-engine-denied",
    DATABASE_URL: "postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield",
    DATABASE_DIRECT_URL: "postgresql://lyrashield:disposable-only@postgres:5432/lyrashield",
    DATABASE_SYSTEM_URL: "postgresql://lyrashield:disposable-only@postgres:5432/lyrashield",
    REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://s3:9000",
    S3_BUCKET: "disposable-evidence",
    S3_ACCESS_KEY: "fixture-access-only",
    S3_SECRET_KEY: "fixture-secret-only",
  }
  requireDisposable(env, "write")
  for (const key of [
    "DATABASE_URL",
    "DATABASE_DIRECT_URL",
    "DATABASE_SYSTEM_URL",
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "LYRASHIELD_WORKER_IMAGE_DIGEST",
    "GH_TOKEN",
    "DOCKER_HOST",
  ]) {
    assert.throws(() => requireDisposable({ ...env, [key]: "outside-disposable-fixture" }, "write"))
  }
  assert.throws(() =>
    requireDisposable({ ...env, LYRASHIELD_LOCAL_EVIDENCE_STORAGE: "1" }, "write")
  )
  assert.throws(() => requireDisposable(env, "denied"))
})

const writerFixtures = process.env.LYRA_DRILL_WRITER_FIXTURES
const readerSource = process.env.LYRA_DRILL_READER_SOURCE
test(
  "actual pinned inputs survive the product parser and canonical winner selection",
  {
    skip:
      !writerFixtures && !readerSource
        ? "external writer fixture directory and reader TS source required"
        : false,
  },
  async () => {
    assert.ok(writerFixtures && readerSource, "supply both host-only inputs")
    const deps = {
      ...(await import(pathToFileURL(join(readerSource, "output-parser.ts")))),
      ...(await import(pathToFileURL(join(readerSource, "normalizer.ts")))),
    }
    const cases = [
      ...readWriterFixtures(writerFixtures),
      distinctFixture(fixture),
      legacy("1.0"),
      legacy("1.1"),
    ]
    assert.equal(cases.length, 16)
    const observed = new Map(cases.map((f) => [f.name, qualifyFixture(f, deps)]))
    assert.deepEqual(
      ["shared-capacity", "max-bytes", "omission-limit"].map(
        (name) => observed.get(name).discarded.length
      ),
      [1, 6, 55]
    )
    assert.equal(observed.get("distinct-owners").survivors.length, 2)
    assert.equal(observed.get("overflow-failed").output.httpExchangeExport, null)
  }
)
