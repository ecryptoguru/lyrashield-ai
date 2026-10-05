import test from "node:test"
import assert from "node:assert/strict"
import {
  connectionObservation,
  redisObservation,
  schedulingObservation,
} from "./webhook-empty-state-observer.mjs"
import {
  validateProducerRequest,
  PRODUCTION_CUTOVER_ENABLED,
} from "./webhook-empty-state-producer.mjs"
import { advancePhase, PHASES } from "./webhook-empty-state-phases.mjs"
import { canonical, STATES } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const sourceSha = "a".repeat(40),
  policy = { runId: "1", originalAttempt: 1, sourceSha, nonce: "n".repeat(40) }
test("production producer remains hard-disabled and rejects JSON, counts or paths", () => {
  assert.equal(PRODUCTION_CUTOVER_ENABLED, false)
  assert.equal(
    validateProducerRequest(["collect", "1", "1", sourceSha, policy.nonce], policy).phase,
    "collect"
  )
  for (const extra of ['{"verified":true}', "/tmp/key.pem", "0"])
    assert.throws(() =>
      validateProducerRequest(["collect", "1", "1", sourceSha, policy.nonce, extra], policy)
    )
  for (const phase of ["rollback", "delete-queue", "replay-payments", "arbitrary-command"])
    assert.throws(() => validateProducerRequest([phase, "1", "1", sourceSha, policy.nonce], policy))
})
test("runtime connection observations reject endpoint overrides and transaction migration", () => {
  const url =
    "postgresql://postgres.yejmvtgsxniatmjbwplk:placeholder@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require"
  assert.match(
    connectionObservation(url, "worker", "2026-10-05T09:00:00Z").identitySha256,
    /^[a-f0-9]{64}$/
  )
  assert.throws(() =>
    connectionObservation(url + "&host=db.other.supabase.co", "worker", "2026-10-05T09:00:00Z")
  )
  assert.throws(() =>
    connectionObservation(url.replace(":5432", ":6543"), "migration", "2026-10-05T09:00:00Z", true)
  )
})
test("Redis observation binds exact owned admission and rejects foreign stop", () => {
  const stop = {
    operator: "github-actions",
    reason: "webhook-empty-state",
    owner: "1:1",
    runId: "1",
  }
  assert.equal(
    redisObservation("rediss://placeholder@example.test:6379/0", canonical(stop), "1:1").owner,
    "1:1"
  )
  assert.throws(() =>
    redisObservation("rediss://placeholder@example.test:6379/0", canonical(stop), "2:1")
  )
})
test("raw SQL sees soft-deleted scheduling state and collects all three queues/six states", async () => {
  let sql
  const client = {
    query: async (query) => {
      sql = query
      return { rows: [{ scans: "0", handlers: "0", tracks: "0", parents: "1", writers: "0" }] }
    },
  }
  const queues = Object.fromEntries(
    ["scan", "webhookTrackRetry", "fixGenerate"].map((name) => [
      name,
      {
        getJobCounts: async (...states) => {
          assert.deepEqual(states, STATES)
          return Object.fromEntries(STATES.map((state) => [state, 0]))
        },
        getJobSchedulersCount: async () => 0,
        getRepeatableJobs: async () => [],
      },
    ])
  )
  const observed = await schedulingObservation(client, queues)
  assert.equal(observed.unresolvedParents, 1)
  assert.equal(Object.keys(observed.queues).length, 3)
  assert.doesNotMatch(sql, /deletedAt|DELETE|UPDATE/)
})
test("dangling or valid symlink fence fails closed", async () => {
  const { mkdtempSync, symlinkSync, rmSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { fencePresent } = await import("./webhook-empty-state-startup-fence.mjs")
  const directory = mkdtempSync(join(tmpdir(), "empty-state-fence-"))
  try {
    const path = join(directory, "fence.json")
    symlinkSync(join(directory, "absent"), path)
    assert.throws(() => fencePresent(path), /symlink/)
    rmSync(path)
    writeFileSync(path, "{}")
    assert.equal(fencePresent(path), true)
    rmSync(path)
    assert.equal(fencePresent(path), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})
test("phase progression preserves immutable authorization and rejects skips or rollback", () => {
  const now = Date.parse("2026-10-05T09:00:00Z"),
    H = "a".repeat(64)
  const authorization = {
    ...policy,
    owner: "1:1",
    issuedAt: "2026-10-05T09:00:00Z",
    expiresAt: "2026-10-05T09:30:00Z",
    repositoryId: "1286618458",
    ownerId: "116722580",
    policySha256: H,
    producerSha256: H,
    workflowSha: sourceSha,
  }
  const approved = { ...authorization, enabled: true, revoked: false }
  let state
  for (const phase of PHASES) {
    state = advancePhase(state, phase, authorization, approved, now)
    assert.equal(
      advancePhase(state, phase, authorization, approved, now).authorizationSha256,
      state.authorizationSha256
    )
  }
  assert.throws(
    () => advancePhase(state, "preflight", authorization, approved, now),
    /skipped|rollback/
  )
  assert.throws(() => advancePhase(undefined, "migrate", authorization, approved, now))
  assert.throws(() =>
    advancePhase(state, "resume", authorization, { ...approved, revoked: true }, now)
  )
  assert.throws(() =>
    advancePhase(state, "resume", { ...authorization, nonce: "x".repeat(40) }, approved, now)
  )
})
test("all executable admission actions use single-key owned comparison and reject foreign state", async () => {
  const { ownedAdmission } = await import("./webhook-empty-state-admission.mjs")
  const raw = canonical({
    operator: "github-actions",
    reason: "webhook-empty-state",
    owner: "1:1",
    runId: "1",
  })
  for (const phase of ["claim", "assert", "release"]) {
    const calls = []
    const redis = {
      eval: async (...args) => {
        calls.push(args)
        return 1
      },
    }
    await ownedAdmission(phase, raw, redis)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1], 1)
    assert.equal(calls[0][2], "lyrashield:scan-admission:stopped")
    assert.equal(calls[0][3], raw)
    await assert.rejects(ownedAdmission(phase, raw, { eval: async () => 0 }), /Foreign/)
  }
})
test("fixed migration env binds both aliases without shell evaluation or transaction pooling", async () => {
  const { parseFixedMigrationEnvironment } = await import("./webhook-empty-state-migration-env.mjs")
  const { hashDatabaseIdentity, canonicalSupabaseDatabaseIdentity } =
    await import("../../packages/db/scripts/webhook-empty-state-contract.mjs")
  const url =
    "postgresql://postgres.yejmvtgsxniatmjbwplk:placeholder@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full"
  const identity = hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([url]))
  assert.deepEqual(
    parseFixedMigrationEnvironment(
      `DATABASE_DIRECT_URL=${url}\nMIGRATION_DATABASE_URL=${url}\n`,
      identity
    ),
    { DATABASE_DIRECT_URL: url, DATABASE_URL: url }
  )
  for (const raw of [
    `DATABASE_DIRECT_URL=${url}\nDATABASE_URL=${url}x`,
    `DATABASE_DIRECT_URL=${url}\nDATABASE_DIRECT_URL=${url}`,
    `DATABASE_DIRECT_URL=${url.replace(":5432", ":6543")}`,
    `DATABASE_DIRECT_URL=${url}\nCOMMAND=anything`,
  ])
    assert.throws(() => parseFixedMigrationEnvironment(raw, identity))
})
test("refreshed worker and candidate targets/credential continuity fail closed", async () => {
  const { runtimeFingerprint, validateConsumerFingerprint } =
    await import("./webhook-empty-state-consumer-identity.mjs")
  const env = {
    DATABASE_URL:
      "postgresql://postgres.yejmvtgsxniatmjbwplk:placeholder@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    DATABASE_SYSTEM_URL:
      "postgresql://postgres:placeholder@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres",
    REDIS_URL: "rediss://placeholder@example.test:6379/0",
  }
  const fingerprint = runtimeFingerprint(env)
  const policy = {
    databaseIdentitySha256: fingerprint.database.identitySha256,
    redisIdentitySha256: fingerprint.redis.identitySha256,
    credentials: {
      worker: fingerprint.database.credentialSha256,
      app: fingerprint.database.credentialSha256,
      system: fingerprint.system.credentialSha256,
      redis: fingerprint.redis.credentialSha256,
    },
    candidateCredentials: { app: { system: fingerprint.system.credentialSha256 } },
  }
  assert.equal(validateConsumerFingerprint(fingerprint, policy, "worker"), true)
  assert.equal(validateConsumerFingerprint(fingerprint, policy, "app"), true)
  for (const role of ["worker", "app"])
    for (const changed of [
      { DATABASE_URL: env.DATABASE_URL.replace("yejmvtgsxniatmjbwplk", "abcdefghijklmnopqrst") },
      { DATABASE_SYSTEM_URL: env.DATABASE_SYSTEM_URL.replace("placeholder", "rotated") },
      { REDIS_URL: "rediss://placeholder@wrong.test:6379/0" },
    ])
      assert.throws(() =>
        validateConsumerFingerprint(runtimeFingerprint({ ...env, ...changed }), policy, role)
      )
})
test("backup safe compatibility normalization preserves endpoint identity and rejects overrides", async () => {
  const { normalizeBackupConnection } =
    await import("../../packages/db/scripts/webhook-backup-connection.mjs")
  const url =
    "postgresql://postgres:placeholder@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres?sslmode=require"
  const expected = normalizeBackupConnection(url).identitySha256
  for (const key of ["uselibpqcompat", "%75selibpqcompat"])
    assert.equal(normalizeBackupConnection(url + `&${key}=1`).identitySha256, expected)
  for (const suffix of [
    "&uselibpqcompat=1&host=wrong.test",
    "&uselibpqcompat=1&user=wrong",
    "&uselibpqcompat=1&uselibpqcompat=1",
    "&uselibpqcompat=0",
    "&%68ost=wrong.test",
  ])
    assert.throws(() => normalizeBackupConnection(url + suffix))
})
test("Azure inventory always includes inactive revisions and uses supported fixed target flags", async () => {
  const { revisionListArgs, containerAppTargetArgs } =
    await import("./webhook-empty-state-azure-target.mjs")
  const resource =
    "/subscriptions/b2f8f58b-18f5-4e49-ac53-06ea04ff0f4c/resourceGroups/LyraShieldAI/providers/Microsoft.App/containerApps/lyrashield-app"
  const args = revisionListArgs(resource)
  assert.equal(args.includes("--all"), true)
  assert.equal(args.includes("--ids"), false)
  assert.equal(args[args.indexOf("--name") + 1], "lyrashield-app")
  assert.throws(() => containerAppTargetArgs(resource.replace("lyrashield-app", "foreign-app")))
})
test("candidate health under stop precedes release; post-release failures restore hold and preserve foreign owners", async () => {
  const { releaseOwnedMaintenance } = await import("./webhook-empty-state-phases.mjs")
  for (const failAt of [null, "public", "authorization", "persist", "cleanup"]) {
    let key = "owned",
      proof = false
    const calls = []
    proof = true
    calls.push("candidate-health-under-stop")
    assert.equal(key, "owned")
    const operations = {
      release: () => {
        assert.equal(proof, true)
        assert.equal(key, "owned")
        calls.push("release")
        key = null
      },
      checkPublicReadiness: () => {
        assert.equal(key, null)
        calls.push("public")
        if (failAt === "public") throw Error("503")
      },
      recheckAuthorization: () => {
        calls.push("authorization")
        if (failAt === "authorization") throw Error("expired")
      },
      persistCompletion: () => {
        calls.push("persist")
        if (failAt === "persist") throw Error("crash after DEL")
      },
      cleanupOwnedFence: () => {
        calls.push("cleanup")
        if (failAt === "cleanup") throw Error("disk failure")
      },
      restoreOwnedHold: () => {
        calls.push("restore")
        assert.equal(key, null)
        key = "owned"
      },
    }
    if (failAt) {
      await assert.rejects(releaseOwnedMaintenance(operations))
      assert.equal(key, "owned")
    } else {
      await releaseOwnedMaintenance(operations)
      assert.equal(key, null)
    }
    assert.deepEqual(calls.slice(0, 3), ["candidate-health-under-stop", "release", "public"])
  }
  let key = "foreign"
  await assert.rejects(
    releaseOwnedMaintenance({
      release: () => {
        throw Error("foreign owner")
      },
      restoreOwnedHold: () => {
        key = "owned"
      },
    })
  )
  assert.equal(key, "foreign")
})
test("acquired restore proof binds exact produced backup object, generation and target", async () => {
  const { bindRestoreProof } = await import("./webhook-empty-state-backup-proof.mjs")
  const { sha256 } = await import("../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs")
  const H = "a".repeat(64),
    S = "b".repeat(40)
  const backup = {
    runId: "120",
    objectIdSha256: H,
    versionId: 'etag:"123"',
    encryptedSha256: H,
    dumpSha256: H,
    databaseIdentitySha256: H,
    createdAt: "2026-10-05T08:00:00Z",
  }
  const policy = { restoreArtifactId: 1, backupSourceSha: S, databaseIdentitySha256: H }
  const record = { id: 1, expired: false, workflow_run: { id: 120, head_sha: S } }
  const proof = {
    schemaVersion: "webhook-empty-state-restore-evidence/v2",
    runId: "120",
    sourceSha: S,
    objectIdSha256: H,
    versionIdSha256: sha256('"123"'),
    encryptedSha256: H,
    dumpSha256: H,
    databaseIdentitySha256: H,
    completedAt: "2026-10-05T08:30:00Z",
    schemaSha256: H,
    auditSha256: H,
    readinessSha256: H,
  }
  assert.equal(
    bindRestoreProof(proof, backup, policy, record).backupSha256,
    sha256(canonical(backup))
  )
  for (const field of [
    "objectIdSha256",
    "versionIdSha256",
    "encryptedSha256",
    "databaseIdentitySha256",
  ])
    assert.throws(() =>
      bindRestoreProof({ ...proof, [field]: "c".repeat(64) }, backup, policy, record)
    )
  assert.throws(() => bindRestoreProof(proof, backup, policy, { ...record, expired: true }))
})

test("fixed runtime acceptance rejects any missing or changed CLI before admission", async () => {
  const { CLI_ARGUMENTS, validateRuntimeReadbacks } =
    await import("./webhook-empty-state-runtime.mjs")
  const versions = Object.fromEntries(
    Object.keys(CLI_ARGUMENTS).map((name) => [name, name + " pinned"])
  )
  validateRuntimeReadbacks(versions, versions)
  for (const name of Object.keys(versions)) {
    const absent = { ...versions }
    delete absent[name]
    assert.throws(() => validateRuntimeReadbacks(absent, versions))
    assert.throws(() => validateRuntimeReadbacks({ ...versions, [name]: "changed" }, versions))
    assert.throws(() => validateRuntimeReadbacks(versions, absent))
  }
})

test("installed-layout executable adapters resolve their graph and remain disabled without ambient PATH", async () => {
  const { mkdtempSync, mkdirSync, cpSync, realpathSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join, dirname, resolve } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const { createRequire } = await import("node:module")
  const { spawnSync } = await import("node:child_process")
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "empty-state-installed-layout-")))
  try {
    for (const path of ["ops/worker", "packages/db/scripts"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      cpSync(join(source, path), join(root, path), { recursive: true })
    }
    // Package subpath exports intentionally omit package.json; resolve its actual entry.
    const entry = realpathSync(
      createRequire(new URL("../../packages/db/package.json", import.meta.url)).resolve(
        "pg-connection-string"
      )
    )
    mkdirSync(join(root, "node_modules"))
    cpSync(dirname(entry), join(root, "node_modules/pg-connection-string"), { recursive: true })
    for (const name of ["producer", "run-migration", "candidate", "backup-proof"]) {
      const result = spawnSync(
        process.execPath,
        [join(root, `ops/worker/webhook-empty-state-${name}.mjs`)],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { PATH: "", HOME: root },
        }
      )
      assert.equal(result.status, 1, name)
      assert.equal(result.stdout, "", name)
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ReferenceError|SyntaxError/, name)
      assert.match(result.stderr, /disabled|failed|retain maintenance/i, name)
    }
  } finally {
    rmSync(root, { recursive: true })
  }
})

test("observer runtime preflight requires actual exported shared queue authorities", async () => {
  const { validateObserverRuntime } = await import("./webhook-empty-state-observer.mjs")
  const integrations = Object.fromEntries(
    ["getScanQueue", "getWebhookTrackRetryQueue", "getFixGenerateQueue"].map((name) => [
      name,
      () => {},
    ])
  )
  validateObserverRuntime(class {}, class {}, integrations)
  for (const name of Object.keys(integrations)) {
    const missing = { ...integrations }
    delete missing[name]
    assert.throws(() => validateObserverRuntime(class {}, class {}, missing))
  }
  assert.throws(() => validateObserverRuntime(undefined, class {}, integrations))
})

test("backup collector normalizes logical identity while retaining raw credential binding", async () => {
  const { backupConnectionObservation } = await import("./webhook-empty-state-observer.mjs")
  const raw =
    "postgresql://postgres.yejmvtgsxniatmjbwplk:placeholder@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require"
  const a = backupConnectionObservation(raw, "2026-10-05T09:00:00Z"),
    b = backupConnectionObservation(raw + "&uselibpqcompat=1", "2026-10-05T09:00:00Z")
  assert.equal(a.identitySha256, b.identitySha256)
  assert.notEqual(a.credentialSha256, b.credentialSha256)
  assert.throws(() =>
    backupConnectionObservation(
      raw + "&uselibpqcompat=1&host=db.foreign.supabase.co",
      "2026-10-05T09:00:00Z"
    )
  )
})

test("cold worker startup polls boundedly and fails on wrong image, unhealthy or timeout", async () => {
  const { waitForWorkerReady } = await import("./webhook-empty-state-candidate.mjs")
  const image = "fixture@sha256:" + "a".repeat(64),
    sourceSha = "b".repeat(40)
  let tick = 0,
    calls = 0
  const states = [
    null,
    { image, sourceSha, status: "running", health: "starting" },
    { image, sourceSha, status: "running", health: "healthy" },
  ]
  await waitForWorkerReady(
    () => states.shift(),
    image,
    sourceSha,
    () => calls++,
    {
      now: () => tick,
      pause: async (ms) => {
        tick += ms
      },
      timeoutMs: 50,
      pollMs: 10,
    }
  )
  assert.equal(calls, 3)
  for (const actual of [
    { image: "foreign", sourceSha, status: "running", health: "healthy" },
    { image, sourceSha, status: "exited" },
    { image, sourceSha, status: "running", health: "unhealthy" },
  ])
    await assert.rejects(
      waitForWorkerReady(
        () => actual,
        image,
        sourceSha,
        () => {},
        { timeoutMs: 1 }
      )
    )
  tick = 0
  await assert.rejects(
    waitForWorkerReady(
      () => null,
      image,
      sourceSha,
      () => {},
      {
        now: () => tick,
        pause: async (ms) => {
          tick += ms
        },
        timeoutMs: 20,
        pollMs: 10,
      }
    ),
    /timed out/
  )
})

test("candidate activation recovery accepts only exact owned image/revision/completion", async () => {
  const { activationIntent, validateActivationIntent } =
    await import("./webhook-empty-state-candidate.mjs")
  const authorization = { sourceSha: "a".repeat(40), runId: "1", nonce: "original" },
    proof = { state: "complete" }
  const policy = {
    resources: { app: "fixture/app", scanner: "fixture/scanner" },
    candidateRevisions: { app: "app-candidate", scanner: "scanner-candidate" },
    images: {
      app: "fixture/app@sha256:" + "a".repeat(64),
      scanner: "fixture/scanner@sha256:" + "b".repeat(64),
    },
  }
  for (const role of ["app", "scanner"]) {
    const intent = activationIntent(authorization, proof, policy, role)
    assert.equal(validateActivationIntent(undefined, authorization, proof, policy, role), false)
    assert.equal(validateActivationIntent(intent, authorization, proof, policy, role), true)
    for (const key of [
      "authorizationSha256",
      "completionSha256",
      "resourceId",
      "revision",
      "image",
    ])
      assert.throws(() =>
        validateActivationIntent(
          { ...intent, [key]: "foreign" },
          authorization,
          proof,
          policy,
          role
        )
      )
  }
})
