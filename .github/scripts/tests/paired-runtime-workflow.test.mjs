import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { armedAuthority, recoveryAuthority, hashRecord } from "../paired-runtime-authority.mjs"
import {
  qualifiedFleetSchema,
  qualificationControlPlaneFields,
} from "../paired-runtime-qualification.mjs"

import {
  CONTROLLER_ACTIONS,
  createControllerActions,
  parseControllerInvocation,
  preflightQualifiedRelease,
  runCli,
  runController,
  verifyPairedAuthority,
} from "../paired-runtime-workflow.mjs"

const { parse } = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)("yaml")
const H = (value) => createHash("sha256").update(value).digest("hex")
const D = (value) => "sha256:" + H(value)
const source = "a".repeat(40)
const owner = "42:1"
const rollbackSource = "b".repeat(40)
const qualified = H("qualified-release-record")
const arm = H("arm-record")
const restore = H("restore-record")
const rollbackArchive = H("rollback-qualified-fleet")

function pair(productRevision = source, engineRevision = "c".repeat(40)) {
  return {
    owner,
    productRevision,
    engineRevision,
    workerDigest: D("worker"),
    webDigest: D("web"),
    proxyDigest: D("proxy"),
    priorWorkerDigest: D("prior-worker"),
    sandboxDigest: D("sandbox"),
    app: { candidate: "app--candidate", previous: "app--previous" },
    scanner: { candidate: "scanner--candidate", previous: "scanner--previous" },
    relay: { candidate: "relay--candidate", previous: "relay--previous" },
  }
}

function releaseRecord(overrides = {}) {
  const current = pair()
  const rollbackPair = {
    ...pair(rollbackSource),
    owner: "41:1",
    workerDigest: D("rollback-worker"),
    webDigest: D("rollback-web"),
    proxyDigest: D("rollback-proxy"),
    app: { candidate: "app--rollback", previous: "app--older" },
    scanner: { candidate: "scanner--rollback", previous: "scanner--older" },
    relay: { candidate: "relay--rollback", previous: "relay--older" },
  }
  const record = {
    kind: "qualified-release",
    owner,
    pair: current,
    controlPlane: {
      migrationChecksum: D("migration"),
      brokerDigest: D("broker"),
      supervisorDigest: D("supervisor"),
      providerGatewayDigest: D("provider-gateway"),
      runtimePolicyDigest: D("runtime-policy"),
    },
    rollback: {
      archiveSha256: rollbackArchive,
      productRevision: rollbackPair.productRevision,
      engineRevision: rollbackPair.engineRevision,
      workerDigest: rollbackPair.workerDigest,
      webDigest: rollbackPair.webDigest,
      proxyDigest: rollbackPair.proxyDigest,
      sandboxDigest: rollbackPair.sandboxDigest,
      appRevision: rollbackPair.app.candidate,
      scannerRevision: rollbackPair.scanner.candidate,
      relayRevision: rollbackPair.relay.candidate,
      migrationChecksum: D("migration"),
      brokerDigest: D("rollback-broker"),
      supervisorDigest: D("rollback-supervisor"),
      providerGatewayDigest: D("rollback-provider-gateway"),
      runtimePolicyDigest: D("rollback-runtime-policy"),
    },
  }
  Object.assign(record, overrides)
  return { record, rollbackPair }
}

function fixture(t, overrides = {}) {
  const { record, rollbackPair } = releaseRecord(overrides.record)
  const archive = {
    kind: "qualified-fleet",
    schema: qualifiedFleetSchema,
    pair: rollbackPair,
    controlPlane: Object.fromEntries(
      [
        "migrationChecksum",
        "brokerDigest",
        "supervisorDigest",
        "providerGatewayDigest",
        "runtimePolicyDigest",
      ].map((key) => [key, record.rollback?.[key]])
    ),
    releaseProof: H("release"),
    sandboxProof: H("sandbox"),
    financialProof: H("financial"),
    readerProof: H("reader"),
    connectionProof: H("connection"),
  }
  const events = []
  const adapter = {
    stageStore: { kind: "fixture-stage-store" },
    async verifyQualifiedArchive(id) {
      events.push("rollback-archive:" + id)
      if (overrides.rollbackArchiveUnavailable) throw new Error("archive unavailable")
      return true
    },
    async verifyRollbackAvailability(actual) {
      events.push("rollback-available:" + actual.productRevision)
      if (overrides.rollbackUnavailable) throw new Error("rollback unavailable")
      return true
    },
  }
  const artifact = (kind, digest) => {
    events.push("artifact:" + kind + ":" + digest)
    if (overrides.artifactError) throw overrides.artifactError
    if (kind === "qualified-release" && digest === qualified) {
      return {
        raw: JSON.stringify(record),
        owner,
        source,
        artifactId: "11",
      }
    }
    if (kind === "arm" && digest === arm) return { raw: "{}", owner, source, artifactId: "12" }
    if (kind === "restore" && digest === restore)
      return { raw: "{}", owner, source, artifactId: "13" }
    throw new Error("wrong artifact")
  }
  const deps = {
    readSource() {
      events.push("source")
      if (overrides.sourceError) throw overrides.sourceError
      return { source }
    },
    async readOwner() {
      events.push("owner")
      if (overrides.ownerError) throw overrides.ownerError
      return owner
    },
    async verifyArtifact(kind, digest) {
      return artifact(kind, digest)
    },
    async readProtectedRecord(kind, digest) {
      events.push("record:" + kind + ":" + digest)
      if (kind !== "qualified-fleet" || digest !== rollbackArchive) throw new Error("wrong record")
      if (overrides.rollbackRecordError) throw overrides.rollbackRecordError
      return JSON.stringify(archive)
    },
    createAdapter() {
      events.push("adapter")
      return adapter
    },
    async verifyAuthority(context) {
      events.push("authority:" + context.source + ":" + context.owner)
      if (overrides.authorityError) throw overrides.authorityError
      return true
    },
    signal: new AbortController().signal,
    actions: {
      async forward(context) {
        events.push("action:forward:" + context.pair.workerDigest)
      },
      async canary(context, invocation) {
        events.push("action:canary:" + invocation.armSha256)
      },
      async restore(context, invocation) {
        events.push("action:restore:" + invocation.restorePhase + ":" + invocation.restoreSha256)
      },
      async release(context, invocation) {
        events.push("action:release:" + invocation.releaseStage)
      },
    },
    stdout: { write() {} },
    stderr: { write() {} },
  }
  t.after(() => {
    // Fixtures are entirely in memory; no external state owns a cleanup step.
  })
  return { record, archive, rollbackPair, events, adapter, deps }
}

test("controller surface is finite and rejects arbitrary commands or extra bodies", () => {
  assert.deepEqual(CONTROLLER_ACTIONS, ["preflight", "forward", "canary", "restore", "release"])
  assert.throws(() => parseControllerInvocation(["forward", "rm", "-rf"]), /exactly one action/)
  assert.throws(() => parseControllerInvocation(["command"]), /unsupported action/)
  assert.throws(() => parseControllerInvocation([], {}), /exactly one action/)
  assert.throws(
    () =>
      parseControllerInvocation(["release"], {
        PAIRED_QUALIFIED_RELEASE_SHA256: qualified,
        PAIRED_RELEASE_STAGE: "restored",
      }),
    /restore digest/
  )
  assert.throws(
    () =>
      parseControllerInvocation(["restore"], {
        PAIRED_QUALIFIED_RELEASE_SHA256: qualified,
        PAIRED_RESTORE_SHA256: restore,
        PAIRED_RESTORE_PHASE: "execute",
      }),
    /restore phase/
  )
  const parsed = parseControllerInvocation(["release"], {
    PAIRED_QUALIFIED_RELEASE_SHA256: qualified,
    PAIRED_RELEASE_STAGE: "forward",
    PAIRED_COMMAND: "ignored",
  })
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "qualifiedReleaseSha256", "releaseStage"])
  assert.equal(parsed.releaseStage, "forward")
  assert.equal(Object.hasOwn(parsed, "command"), false)
})

test("preflight binds source, owner, artifact, signed tuple and available rollback before authority", async (t) => {
  const f = fixture(t)
  const context = await preflightQualifiedRelease(qualified, f.deps)
  assert.equal(context.pair.productRevision, source)
  assert.equal(context.pair.engineRevision, "c".repeat(40))
  assert.equal(context.rollback.productRevision, rollbackSource)
  assert.deepEqual(f.events, [
    "source",
    "owner",
    "artifact:qualified-release:" + qualified,
    "adapter",
    "record:qualified-fleet:" + rollbackArchive,
    "rollback-archive:" + rollbackArchive,
    "rollback-available:" + rollbackSource,
    "authority:" + source + ":" + owner,
  ])
})

function compositionFixture(t, mutateArchive = () => {}, sourceMigration) {
  const f = fixture(t)
  const records = new Map()
  const add = (record) => {
    const id = hashRecord(record)
    records.set(id, JSON.stringify(record))
    return id
  }
  mutateArchive(f.archive)
  const archiveId = add(f.archive)
  f.record.rollback.archiveSha256 = archiveId
  const readProtectedRecord = async (kind, id) => {
    const raw = records.get(id)
    assert.equal(JSON.parse(raw).kind, kind)
    return raw
  }
  f.deps.readProtectedRecord = readProtectedRecord
  f.adapter.readProtectedRecord = readProtectedRecord
  let authorityOwner = owner
  f.adapter.readAuthenticatedOwner = async () => authorityOwner
  f.adapter.verifyArmAuthorization = async () => true
  f.adapter.verifyRecoveryHandoff = async () => true
  const armAcquisition = add({
    kind: "hold-acquisition",
    owner,
    fleet: archiveId,
    continuity: H("arm-continuity"),
    selectorHash: null,
  })
  const armId = add({
    kind: "arm",
    nonce: H("nonce"),
    owner,
    sourceAcquisition: armAcquisition,
    selectorHash: H("selector"),
    inputHash: H("input"),
    issuedAtMs: 1000,
    expiresAtMs: 301000,
    capUsd: 1,
  })
  const sourcePair = structuredClone(f.record.pair)
  sourcePair.owner = "40:1"
  sourcePair.priorWorkerDigest = f.rollbackPair.workerDigest
  for (const name of ["app", "scanner", "relay"])
    sourcePair[name].previous = f.rollbackPair[name].candidate
  const sourceArchive = {
    ...f.archive,
    pair: sourcePair,
    controlPlane: structuredClone(f.record.controlPlane),
  }
  if (sourceMigration) sourceArchive.controlPlane.migrationChecksum = sourceMigration
  const sourceId = add(sourceArchive)
  const acquisition = add({
    kind: "hold-acquisition",
    owner,
    fleet: sourceId,
    continuity: H("restore-continuity"),
    selectorHash: H("selector"),
  })
  const newOwner = "43:1",
    nonce = H("restore-nonce")
  const reverse = {
    ...structuredClone(f.rollbackPair),
    owner: newOwner,
    priorWorkerDigest: sourcePair.workerDigest,
  }
  for (const name of ["app", "scanner", "relay"])
    reverse[name] = {
      previous: sourcePair[name].candidate,
      candidate: f.rollbackPair[name].candidate,
    }
  const reversePlan = hashRecord(reverse)
  const handoff = add({
    kind: "handoff",
    authorization: "original-owner",
    sourceOwner: owner,
    newOwner,
    sourceAcquisition: acquisition,
    destinationArchive: archiveId,
    reversePlan,
    nonceHash: hashRecord(nonce),
  })
  const restoreId = add({
    kind: "restore",
    nonce,
    owner: newOwner,
    sourceAcquisition: acquisition,
    destinationArchive: archiveId,
    reversePlan,
    handoff,
    baselineEvidence: H("baseline-evidence"),
    canaryEvidence: H("canary-evidence"),
  })
  return {
    ...f,
    records,
    archiveId,
    armId,
    restoreId,
    setRecoveryOwner: () => {
      authorityOwner = newOwner
    },
  }
}

test("one canonical signed v2 archive passes workflow preflight and actual arm/recovery parsers", async (t) => {
  const f = compositionFixture(t)
  const context = await preflightQualifiedRelease(qualified, f.deps)
  const armed = await armedAuthority(f.adapter, f.armId, structuredClone)
  f.setRecoveryOwner()
  const recovered = await recoveryAuthority(f.adapter, f.restoreId, structuredClone)
  const raw = f.records.get(f.archiveId)
  assert.equal(hashRecord(JSON.parse(raw)), context.rollback.archiveSha256)
  assert.equal(JSON.stringify(armed.fleet), raw)
  assert.equal(JSON.stringify(recovered.archive), raw)
  assert.deepEqual(recovered.archive.controlPlane, f.archive.controlPlane)
})

test("legacy, unknown and incomplete archive schemas fail both composed consumers", async (t) => {
  for (const mutate of [
    (a) => {
      delete a.schema
    },
    (a) => {
      a.schema = "lyrashield-qualified-fleet/1"
    },
    (a) => {
      a.schema = "lyrashield-qualified-fleet/3"
    },
    (a) => {
      a.extra = true
    },
    (a) => {
      delete a.controlPlane
    },
    ...qualificationControlPlaneFields.map((field) => (a) => {
      delete a.controlPlane[field]
    }),
    ...qualificationControlPlaneFields.map((field) => (a) => {
      a.controlPlane[field] = "invalid"
    }),
    (a) => {
      a.controlPlane.extra = D("unexpected")
    },
  ]) {
    const f = compositionFixture(t, mutate)
    await assert.rejects(
      preflightQualifiedRelease(qualified, f.deps),
      /rollback archive schema invalid/
    )
    await assert.rejects(armedAuthority(f.adapter, f.armId, structuredClone))
    f.setRecoveryOwner()
    await assert.rejects(recoveryAuthority(f.adapter, f.restoreId, structuredClone))
  }
})

test("composed recovery refuses a different signed migration instead of rolling schema backward", async (t) => {
  const f = compositionFixture(t, undefined, D("different-migration"))
  await preflightQualifiedRelease(qualified, f.deps)
  f.setRecoveryOwner()
  await assert.rejects(recoveryAuthority(f.adapter, f.restoreId, structuredClone), /proof mismatch/)
})

test("each controller action uses one allowlisted implementation after preflight", async (t) => {
  const cases = [
    [["preflight"], "preflight"],
    [["forward"], "forward"],
    [["canary"], "canary"],
    [["restore"], "restore"],
    [["release"], "release"],
  ]
  for (const [argv, action] of cases) {
    const f = fixture(t)
    const invocation = await runController(argv, {
      ...f.deps,
      environment:
        action === "canary"
          ? { PAIRED_QUALIFIED_RELEASE_SHA256: qualified, PAIRED_ARM_SHA256: arm }
          : action === "restore"
            ? { PAIRED_QUALIFIED_RELEASE_SHA256: qualified, PAIRED_RESTORE_SHA256: restore }
            : action === "release"
              ? { PAIRED_QUALIFIED_RELEASE_SHA256: qualified, PAIRED_RELEASE_STAGE: "forward" }
              : { PAIRED_QUALIFIED_RELEASE_SHA256: qualified },
    })
    assert.equal(invocation.action, action)
    assert.equal(
      f.events.some((event) => event.startsWith("action:" + action + ":")) ||
        action === "preflight",
      true,
      JSON.stringify({ action, events: f.events })
    )
    assert.equal(
      f.events.filter(
        (event) => event.startsWith("action:") && !event.startsWith("action:" + action)
      ).length,
      0
    )
    const actionIndex = f.events.findIndex((e) => e.startsWith("action:"))
    if (actionIndex >= 0)
      assert.ok(f.events.indexOf("authority:" + source + ":" + owner) < actionIndex)
  }
})

test("default controller action map dispatches only the fixed forward, canary, restore and release functions", async () => {
  const calls = []
  const implementations = Object.fromEntries(
    [
      "promoteHeldPair",
      "releaseArmedCanary",
      "restoreQualifiedPair",
      "inspectReboundPair",
      "retryUnappliedRebind",
      "finishReboundPair",
      "releaseVerifiedPair",
      "releaseRestoredPair",
    ].map((name) => [
      name,
      async (...args) => {
        calls.push([name, ...args.slice(1)])
      },
    ])
  )
  const adapter = {
    stageStore: { protected: true },
    arbitrary: async () => assert.fail("unreachable arbitrary implementation"),
  }
  const signal = new AbortController().signal
  const actions = createControllerActions(implementations, adapter, signal)
  const context = { pair: pair() }
  await actions.forward(context)
  await actions.canary(context, { armSha256: arm })
  await actions.restore(context, { restorePhase: "begin", restoreSha256: restore })
  await actions.restore(context, { restorePhase: "inspect", restoreSha256: restore })
  await actions.restore(context, { restorePhase: "retry", restoreSha256: restore })
  await actions.restore(context, { restorePhase: "finish", restoreSha256: restore })
  await actions.release(context, { releaseStage: "forward" })
  await actions.release(context, { releaseStage: "restored", restoreSha256: restore })
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "promoteHeldPair",
      "releaseArmedCanary",
      "restoreQualifiedPair",
      "inspectReboundPair",
      "retryUnappliedRebind",
      "finishReboundPair",
      "releaseVerifiedPair",
      "releaseRestoredPair",
    ]
  )
  assert.equal(Object.keys(actions).sort().join(","), "canary,forward,release,restore")
  assert.throws(
    () => actions.restore(context, { restorePhase: "command", restoreSha256: restore }),
    /unsupported restore phase/
  )
  assert.throws(
    () => actions.release(context, { releaseStage: "arbitrary" }),
    /unsupported release stage/
  )
})

test("malformed digest, source, owner and action artifact failures stop before adapter or action", async (t) => {
  const cases = [
    {
      argv: ["forward"],
      env: { PAIRED_QUALIFIED_RELEASE_SHA256: "bad" },
      expected: /qualified release digest/,
    },
    {
      argv: ["forward"],
      env: { PAIRED_QUALIFIED_RELEASE_SHA256: qualified },
      overrides: { sourceError: new Error("source drift") },
      expected: /source verification failed/,
    },
    {
      argv: ["forward"],
      env: { PAIRED_QUALIFIED_RELEASE_SHA256: qualified },
      overrides: { ownerError: new Error("owner drift") },
      expected: /owner verification failed/,
    },
    {
      argv: ["canary"],
      env: { PAIRED_QUALIFIED_RELEASE_SHA256: qualified, PAIRED_ARM_SHA256: arm },
      overrides: { artifactError: new Error("wrong run or signer secret lsk_should_not_leak") },
      expected: /protected artifact unavailable/,
    },
  ]
  for (const c of cases) {
    const f = fixture(t, c.overrides)
    await assert.rejects(runController(c.argv, { ...f.deps, environment: c.env }), c.expected)
    assert.equal(f.events.includes("adapter"), false)
    assert.equal(
      f.events.some((event) => event.startsWith("action:")),
      false
    )
  }
})

test("preflight accepts only the two protected owner workflows", async (t) => {
  const f = fixture(t)
  await assert.rejects(
    preflightQualifiedRelease(qualified, {
      ...f.deps,
      ownerWorkflow: ".github/workflows/untrusted.yml",
    }),
    /owner workflow unavailable/
  )
  assert.equal(f.events.includes("owner"), false)
  const deploy = fixture(t)
  await preflightQualifiedRelease(qualified, {
    ...deploy.deps,
    ownerWorkflow: ".github/workflows/deploy-azure.yml",
  })
  const action = fixture(t)
  await assert.rejects(
    preflightQualifiedRelease(
      qualified,
      { ...action.deps, ownerWorkflow: ".github/workflows/deploy-azure.yml" },
      { action: "forward", qualifiedReleaseSha256: qualified }
    ),
    /owner workflow unavailable/
  )
})

test("default authority remains unavailable and no action can run", async (t) => {
  await assert.rejects(verifyPairedAuthority({}), /broker\/supervisor authority unavailable/i)
  const f = fixture(t)
  await assert.rejects(
    runController(["forward"], {
      ...f.deps,
      environment: { PAIRED_QUALIFIED_RELEASE_SHA256: qualified },
      verifyAuthority: verifyPairedAuthority,
    }),
    /authority unavailable/
  )
  assert.equal(
    f.events.some((event) => event.startsWith("action:")),
    false
  )
})

test("preflight requires affirmative archive, rollback and authority verification", async (t) => {
  const checks = [
    ["verifyQualifiedArchive", "adapter", /rollback archive unavailable/],
    ["verifyRollbackAvailability", "adapter", /rollback availability unverified/],
    ["verifyAuthority", "deps", /paired broker\/supervisor authority unavailable/],
  ]
  for (const [name, target, expected] of checks) {
    for (const unverified of [false, undefined, null]) {
      const f = fixture(t)
      f[target][name] = async () => unverified
      await assert.rejects(preflightQualifiedRelease(qualified, f.deps), expected, name)
      assert.equal(
        f.events.some((event) => event.startsWith("action:")),
        false
      )
    }
  }
})

test("held-baseline is not accepted as admission-open qualified-fleet recovery authority", async (t) => {
  const f = fixture(t)
  f.archive.kind = "held-baseline"
  f.archive.purpose = "rollback-only"
  await assert.rejects(preflightQualifiedRelease(qualified, f.deps), /rollback record unavailable/)
  assert.equal(
    f.events.some((event) => event.startsWith("authority:")),
    false
  )
  assert.equal(
    f.events.some((event) => event.startsWith("rollback-archive:")),
    false
  )
})

test("rollback comparison binds migration, broker, supervisor, gateway and runtime policy", async (t) => {
  for (const field of [
    "migrationChecksum",
    "brokerDigest",
    "supervisorDigest",
    "providerGatewayDigest",
    "runtimePolicyDigest",
  ]) {
    const f = fixture(t)
    f.archive.controlPlane[field] = D("different")
    await assert.rejects(
      preflightQualifiedRelease(qualified, f.deps),
      /rollback tuple mismatch/,
      field
    )
    assert.equal(
      f.events.some((event) => event.startsWith("authority:")),
      false
    )
    delete f.archive.controlPlane[field]
    await assert.rejects(
      preflightQualifiedRelease(qualified, f.deps),
      /rollback archive schema invalid/
    )
  }
})

test("missing, unavailable or forward-incompatible rollback fails before authority and mutation", async (t) => {
  const variants = [
    { record: { rollback: undefined }, expected: /rollback tuple/ },
    { rollbackRecordError: new Error("missing archive"), expected: /rollback record unavailable/ },
    { rollbackArchiveUnavailable: true, expected: /rollback archive unavailable/ },
    { rollbackUnavailable: true, expected: /rollback availability unverified/ },
  ]
  for (const variant of variants) {
    const f = fixture(t, variant)
    await assert.rejects(
      preflightQualifiedRelease(qualified, {
        ...f.deps,
        environment: { PAIRED_QUALIFIED_RELEASE_SHA256: qualified },
      }),
      variant.expected
    )
    assert.equal(
      f.events.some((event) => event.startsWith("authority:")),
      false
    )
    assert.equal(
      f.events.some((event) => event.startsWith("action:")),
      false
    )
  }
  for (const mutate of [
    (r) => {
      r.rollback.engineRevision = "3001517530300ca5f602536bfadcbd3c95ad3039"
    },
    (r) => {
      r.rollback.migrationChecksum = D("different-schema")
    },
    (r) => {
      r.rollback.workerDigest = D("wrong-worker")
    },
  ]) {
    const f = fixture(t)
    mutate(f.record)
    await assert.rejects(preflightQualifiedRelease(qualified, f.deps), /rollback tuple mismatch/)
    assert.equal(
      f.events.some((event) => event.startsWith("authority:")),
      false
    )
  }
})

test("CLI failures expose only fixed diagnostics and never dependency errors or credentials", async (t) => {
  const f = fixture(t, { artifactError: new Error("lsk_live_secret must never appear") })
  let stderr = ""
  const code = await runCli(["forward"], {
    ...f.deps,
    environment: { PAIRED_QUALIFIED_RELEASE_SHA256: qualified },
    stderr: {
      write(value) {
        stderr += value
      },
    },
  })
  assert.equal(code, 1)
  assert.match(stderr, /Paired release controller blocked/)
  assert.doesNotMatch(stderr, /lsk_live_secret|must never appear/)
  assert.equal(
    f.events.some((event) => event.startsWith("action:")),
    false
  )
})

test("deploy workflows expose an opt-in protected digest and run read-only preflight before mutation", () => {
  const deploy = parse(readFileSync(".github/workflows/deploy-azure.yml", "utf8"))
  const runtime = parse(readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8"))
  const production = parse(readFileSync(".github/workflows/release-production.yml", "utf8"))
  for (const workflow of [deploy, runtime]) {
    assert.equal(workflow.on.workflow_call.inputs.qualified_release_digest.default, "")
    assert.equal(workflow.on.workflow_call.inputs.qualified_release_digest.type, "string")
  }
  assert.equal(deploy.on.workflow_dispatch.inputs.qualified_release_digest.default, "")
  const preflightJob = deploy.jobs["preflight-compatible-baseline"]
  const preflightStep = preflightJob.steps.find(
    (step) => step.name === "Preflight protected paired release"
  )
  const registryLogin = preflightJob.steps.findIndex(
    (step) => step.name === "Authenticate qualified rollback image reads"
  )
  const preflightIndex = preflightJob.steps.indexOf(preflightStep)
  assert.ok(preflightStep)
  assert.ok(registryLogin >= 0 && registryLogin < preflightIndex)
  assert.match(preflightStep.run, /paired-runtime-workflow\.mjs preflight/)
  assert.equal(preflightStep.env.PAIRED_JOB_WORKFLOW, ".github/workflows/deploy-azure.yml")
  assert.equal(preflightStep.env.RG, "${{ vars.AZURE_RESOURCE_GROUP }}")
  assert.equal(preflightStep.env.APP_NAME, "${{ vars.AZURE_APP_CONTAINER_APP_NAME }}")
  assert.equal(preflightStep.env.SCANNER_NAME, "${{ vars.AZURE_SCANNER_CONTAINER_APP_NAME }}")
  assert.equal(preflightStep.env.EGRESS_NAME, "${{ vars.AZURE_EGRESS_PROXY_CONTAINER_APP_NAME }}")
  assert.ok(deploy.jobs.build.needs.includes("preflight-compatible-baseline"))
  const runtimeSteps = runtime.jobs.deploy.steps
  const runtimePreflight = runtimeSteps.findIndex(
    (step) => step.name === "Preflight protected paired release"
  )
  const firstProductionMutation = runtimeSteps.findIndex(
    (step) => step.name === "Recheck v26 maintenance before any production mutation"
  )
  const runtimeRegistryLogin = runtimeSteps.findIndex(
    (step) => step.name === "Authenticate qualified rollback image reads"
  )
  assert.ok(runtimePreflight >= 0 && runtimePreflight < firstProductionMutation)
  assert.ok(runtimeRegistryLogin >= 0 && runtimeRegistryLogin < runtimePreflight)
  assert.doesNotMatch(JSON.stringify([deploy, runtime]), /PAIRED_COMMAND|arbitrary command/)
  assert.deepEqual(production.jobs["deploy-azure"].needs, ["routing", "qualify-runtime"])
  assert.equal(
    production.jobs["qualify-runtime"].with.runtime_fleet_configuration,
    "${{ vars.LYRASHIELD_RUNTIME_FLEET_EVIDENCE }}"
  )
  assert.equal(production.jobs["deploy-azure"].with.cold_release, true)
  assert.equal(production.jobs["deploy-azure"].with.qualified_release_digest, undefined)
  assert.equal(runtime.on.workflow_call.inputs.cold_release.default, false)
  assert.equal(
    deploy.jobs["preflight-compatible-baseline"].steps[0].if,
    "inputs.cold_release != true"
  )
})
