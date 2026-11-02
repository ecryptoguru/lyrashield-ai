import { execFileSync, spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import {
  cpSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  unlinkSync,
  realpathSync,
  truncateSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  checkStoredObservation,
  distinctFixture,
  legacy,
  qualifyFixture,
  readWriterFixtures,
  requireLiveLock,
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
  const root = mkdtempSync(join(realpathSync(tmpdir()), "reader-receipt-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(fixture, root, { recursive: true })
  writeFileSync(join(root, "vulnerabilities.json"), "[]")
  assert.throws(() => distinctFixture(root))
})
test("new legacy fixtures have independent launch-compatible identities", () => {
  for (const version of ["1.0", "1.1"]) {
    const f = legacy(version)
    const run = JSON.parse(f.bytes["run.json"])
    assert.equal(run.run_id, f.id)
    assert.equal(run.run_name, f.id)
    assert.equal(run.schema_version, version)
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

test("reject linked, nonregular, oversized, and extra fixture entries", (t) => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "reader-topology-"))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const sentinel = join(base, "outside.json")
  cpSync(join(fixture, "vulnerabilities.json"), sentinel)
  for (const kind of ["symlink", "hardlink", "ancestor", "oversize", "fifo", "extra"]) {
    const root = join(base, kind)
    cpSync(fixture, root, { recursive: true })
    const f = join(root, "vulnerabilities.json")
    if (kind === "ancestor") {
      const alias = join(base, "alias")
      symlinkSync(root, alias, "dir")
      assert.throws(() => distinctFixture(alias))
    } else {
      if (kind === "symlink" || kind === "hardlink") {
        unlinkSync(f)
        if (kind === "symlink") symlinkSync(sentinel, f)
        else linkSync(sentinel, f)
      } else if (kind === "fifo") {
        unlinkSync(f)
        execFileSync("mkfifo", [f])
      } else if (kind === "oversize") truncateSync(f, 8 * 1024 * 1024)
      else writeFileSync(join(root, "extra"), "")
      assert.throws(() => distinctFixture(root), kind)
    }
  }
})

test(
  "real reader oracle rejects changed revision, authority, promotion and foreign capture bytes",
  { skip: !readerSource && !writerFixtures ? "requires actual reader/fixture inputs" : false },
  async () => {
    const deps = {
      ...(await import(pathToFileURL(join(readerSource, "output-parser.ts")))),
      ...(await import(pathToFileURL(join(readerSource, "normalizer.ts")))),
    }
    const f = distinctFixture(fixture)
    const failed = readWriterFixtures(writerFixtures).find((x) => x.name === "outcome-missing")
    for (const [name, input, mutate] of [
      [
        "foreign revision",
        f,
        (o) => {
          o.vulnerabilities[0].update_history[0].reason = "foreign revision"
        },
      ],
      [
        "downgraded authority",
        f,
        (o) => {
          o.vulnerabilities[0].evidence_contract_version = "1.1"
        },
      ],
      [
        "promoted claim",
        f,
        (o) => {
          o.vulnerabilities[0].engine_verification_state = "verified"
        },
      ],
      [
        "failed capture manufactured",
        failed,
        (o) => {
          o.httpExchangeExport = { exchangeCount: 0, document: '{"exchanges":[]}' }
        },
      ],
      [
        "missing required export",
        f,
        (o) => {
          o.httpExchangeExport = null
        },
      ],
      [
        "substituted host/hash",
        f,
        (o) => {
          const doc = JSON.parse(o.httpExchangeExport.document)
          doc.exchanges[0].request.host = "foreign.invalid"
          doc.exchanges[0].request.sha256 = "0".repeat(64)
          o.httpExchangeExport.document = JSON.stringify(doc)
        },
      ],
    ]) {
      assert.throws(
        () =>
          qualifyFixture(input, {
            ...deps,
            parseEngineOutput: (...args) => {
              const o = deps.parseEngineOutput(...args)
              mutate(o)
              return o
            },
          }),
        name
      )
    }
    const shared = readWriterFixtures(writerFixtures).find((x) => x.name === "shared-capacity")
    assert.throws(
      () =>
        qualifyFixture(shared, {
          ...deps,
          normalizeFindings: (...args) => {
            const values = deps.normalizeFindings(...args)
            values[0].http_exchange_ids = ["99"]
            return values
          },
        }),
      /changed winning owner's/
    )
  }
)

test("live lock proof uses the integration Redis client and rejects absent or foreign tokens", async () => {
  const queue = { toKey: (suffix) => "bull:scans:" + suffix }
  for (const stored of ["owned", "foreign", null]) {
    const redis = {
      get: async (key) => {
        assert.equal(key, "bull:scans:original:lock")
        return stored
      },
    }
    if (stored === "owned") await requireLiveLock(redis, queue, "original", "owned")
    else await assert.rejects(() => requireLiveLock(redis, queue, "original", "owned"), /live lock/)
  }
  await assert.rejects(() => requireLiveLock(null, queue, "original", "owned"), /Redis/)
})

test("recovery identity rejects replacement jobs and a first delivery mislabelled as a stall", async () => {
  const { assertRecoveredDelivery } = await import("../worker-evidence-persistence-drill.mjs")
  const original = { id: "same", timestamp: 100, nonce: "one" }
  const restored = {
    ...original,
    data: { drillNonce: "one" },
    attemptsStarted: 2,
    stalledCounter: 1,
  }
  assertRecoveredDelivery(restored, original)
  for (const attr of [
    { id: "other" },
    { timestamp: 101 },
    { data: { drillNonce: "other" } },
    { attemptsStarted: 1 },
    { stalledCounter: 0 },
  ]) {
    assert.throws(() => assertRecoveredDelivery({ ...restored, ...attr }, original))
  }
})

test("failed HTTP export is denied even if an injected parser supplies an empty document", () => {
  const f = legacy("1.1")
  f.row.status = "failed"
  const raw = JSON.parse(f.bytes["vulnerabilities.json"])[0]
  const deps = {
    parseEngineOutput: () => ({
      runRecord: { schema_version: "1.1" },
      vulnerabilities: [raw],
      httpExchangeExport: { document: '{"exchanges":[]}', exchangeCount: 0 },
    }),
  }
  assert.throws(() => qualifyFixture(f, deps), /unexpected HTTP capture artifact/)
})

test("fixture staging materializes only verified bytes, independently of later source changes", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "reader-staging-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = join(root, "input"),
    staged = join(root, "staged")
  cpSync(fixture, input, { recursive: true })
  const helper = fileURLToPath(new URL("../worker-evidence-fixture-io.py", import.meta.url))
  execFileSync("python3", ["-I", "-B", helper, "distinct", input, "--stage", staged])
  const before = distinctFixture(staged)
  writeFileSync(join(input, "vulnerabilities.json"), "[]")
  assert.deepEqual(distinctFixture(staged), before)
  assert.throws(() =>
    execFileSync("python3", ["-I", "-B", helper, "distinct", input, "--stage", join(root, "bad")], {
      stdio: "pipe",
    })
  )
  assert.ok(!existsSync(join(root, "bad")))
})

test("MinIO readiness sends a Host header to the private endpoint and requires status 200", () => {
  const script = readFileSync(
    new URL("../run-worker-evidence-persistence-drill.sh", import.meta.url),
    "utf8"
  )
  const probe = script.split("\n").find((line) => line.includes("GET /minio/health/ready"))
  assert.ok(
    probe.includes(
      String.raw`GET /minio/health/ready HTTP/1.1\r\nHost: s3:9000\r\nConnection: close\r\n\r\n`
    )
  )
  assert.ok(probe.includes('[[ "$line" == *" 200 "* ]]'))
})

test("terminal barrier must abort the status update within the cleanup watchdog even if the client vanishes", () => {
  const script = readFileSync(
    new URL("../run-worker-evidence-persistence-drill.sh", import.meta.url),
    "utf8"
  )
  const barrier = script.match(
    /CREATE FUNCTION fixture_terminal_barrier\(\)[^$]*\$\$([\s\S]*?)\$\$;/
  )[1]
  const seconds = Number(barrier.match(/pg_sleep\((\d+)\)/)[1])
  assert.ok(seconds >= 5 && seconds < 30)
  assert.match(barrier, /pg_sleep\(\d+\);\s*RAISE EXCEPTION/)
  assert.doesNotMatch(barrier, /RETURN NEW/)
})

test("disk gate rejects inadequate or incomparable free space before service startup", () => {
  const guard = fileURLToPath(new URL("../worker-evidence-drill-guard.py", import.meta.url))
  const result = (row) =>
    spawnSync("python3", ["-I", "-B", guard, "space"], {
      input: "Filesystem 1024-blocks Used Available Capacity Mounted on\n" + row + "\n",
    })
  assert.equal(result("overlay 9999999 1 5242880 1% /").status, 0)
  for (const row of [
    "overlay 9999999 1 5242879 1% /",
    "tmpfs 9999999 1 8000000 1% /",
    "overlay 9999999 1 8000000 1% /host",
    "invalid",
  ])
    assert.notEqual(result(row).status, 0)
})

test("host-only phase and whole-run deadlines terminate local sleepers", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "reader-watchdog-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const guard = fileURLToPath(new URL("../worker-evidence-drill-guard.py", import.meta.url))
  const quick = spawnSync(
    "python3",
    ["-I", "-B", guard, "bounded", "1", "python3", "-c", "import time;time.sleep(30)"],
    { timeout: 5000 }
  )
  assert.ifError(quick.error)
  assert.notEqual(quick.status, 0)
  assert.match(quick.stderr.toString(), /fixture phase command exceeded 1s/)
  const sh = join(root, "sleeper.sh"),
    marker = join(root, "unsafe-completion")
  writeFileSync(sh, `sleep 4; touch "${marker}"\n`)
  const full = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      'import runpy,sys; runpy.run_path(sys.argv[1])["supervise"](sys.argv[2],"unused",timeout=1)',
      guard,
      sh,
    ],
    { timeout: 5000 }
  )
  assert.ifError(full.error)
  assert.notEqual(full.status, 0)
  assert.match(full.stderr.toString(), /TimeoutExpired/)
  assert.ok(!existsSync(marker))
})

test("crash preflight never manufactures a replacement for a missing or requeued original", async () => {
  const { requireCrashedJob } = await import("../worker-evidence-persistence-drill.mjs")
  const identity = { id: "fixture", timestamp: 123, nonce: "original" }
  const job = {
    ...identity,
    data: { drillNonce: "original" },
    getState: async () => "active",
    attemptsStarted: 1,
    stalledCounter: 0,
  }
  let adds = 0
  const queue = {
    getJob: async () => job,
    add: () => {
      adds++
    },
  }
  await requireCrashedJob(queue, identity)
  for (const existing of [
    null,
    { ...job, getState: async () => "waiting" },
    { ...job, timestamp: 124 },
    { ...job, data: { drillNonce: "replacement" } },
  ]) {
    await assert.rejects(() =>
      requireCrashedJob({ ...queue, getJob: async () => existing }, identity)
    )
  }
  assert.equal(adds, 0)
})

test("decrypted observation oracle rejects cross-observation data and a capture checksum for pending-only claims", () => {
  const owner = {
    contract: "1.2",
    verification: "unverified",
    revisions: [{ reason: "original" }],
    pending: ["17"],
    captured: [],
  }
  const data = {
    evidenceContractVersion: "1.2",
    engineVerificationState: "unverified",
    sourceScanId: "scan",
    sourceFindingId: "finding",
    updateHistory: owner.revisions,
    pendingHttpExchangeIds: ["17"],
    pendingHttpExchangeState: "PENDING",
  }
  checkStoredObservation(data, owner, "scan", "finding", "unused-export")
  for (const mutation of [
    { engineVerificationState: "verified" },
    { evidenceContractVersion: "1.1" },
    { sourceFindingId: "foreign" },
    { sourceScanId: "foreign" },
    { updateHistory: [{ reason: "other" }] },
    { httpExchangeArtifactChecksum: "unused-export" },
    { httpExchangeIds: ["17"] },
  ]) {
    assert.throws(() =>
      checkStoredObservation({ ...data, ...mutation }, owner, "scan", "finding", "unused-export")
    )
  }
})
