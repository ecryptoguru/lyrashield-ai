import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runtimeQualificationKeyId } from "../../../packages/security/src/sandbox-publication-record.ts"
import { selectQualifiedReleaseImages } from "../select-qualified-release-images.mjs"

const require = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)
const { parse } = require("yaml")
const source = "a".repeat(40)
const tree = "b".repeat(40)
const engine = "c".repeat(40)
const digest = (value) => `sha256:${value.repeat(64)}`
const record = {
  kind: "runtime-fleet-qualification",
  schema: "lyrashield-runtime-fleet-qualification/1",
  purpose: "exact-artifact-release",
  scope: "disposable-linux",
  sourceTree: tree,
  architecture: "amd64",
  fleet: {
    productRevision: source,
    engineRevision: engine,
    webDigest: digest("1"),
    proxyDigest: digest("2"),
    workerDigest: digest("3"),
    sandboxDigest: digest("4"),
    brokerDigest: digest("5"),
    supervisorDigest: digest("6"),
    providerGatewayDigest: digest("7"),
    migrationChecksum: digest("8"),
    runtimePolicyDigest: digest("9"),
  },
  evidence: Object.fromEntries(
    ["native", "migration", "policy", "journal", "rollback", "inventory"].map((name) => [
      name,
      "d".repeat(64),
    ])
  ),
  journal: Object.fromEntries(
    ["sealHash", "recoverySnapshotSha256", "pinEnvelopeHash", "observedControlCasAckHash"].map(
      (name) => [name, "e".repeat(64)]
    )
  ),
  issuer: {
    repositoryId: "1286618458",
    repositoryOwnerId: "116722580",
    workflow: ".github/workflows/issue-runtime-qualification.yml",
    source,
    runId: "123",
    attempt: "1",
  },
  issuedAt: Math.floor(Date.now() / 1000),
}
function fixture(value = record) {
  const raw = JSON.stringify(value)
  return {
    envelope: { raw, result: {} },
    expected: {
      source,
      sourceTree: tree,
      engineRevision: engine,
      recordSha256: createHash("sha256").update(raw).digest("hex"),
    },
  }
}

test("cold release selects exact images with a mocked qualification verifier", () => {
  const { envelope, expected } = fixture()
  const selected = selectQualifiedReleaseImages(envelope, expected, () => {})
  assert.deepEqual(selected, {
    web_image: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web:${source}`,
    web_digest: digest("1"),
    worker_image: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${source}`,
    worker_digest: digest("3"),
    egress_proxy_image: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-egress-proxy:${source}`,
    egress_proxy_digest: digest("2"),
    sandbox_digest: digest("4"),
    engine_revision: engine,
  })
})

test("image selection rejects invalid signatures, source and artifact identity", () => {
  const { envelope, expected } = fixture()
  assert.throws(() =>
    selectQualifiedReleaseImages(envelope, expected, () => {
      throw new Error("signature")
    })
  )
  assert.throws(() =>
    selectQualifiedReleaseImages(envelope, { ...expected, source: "f".repeat(40) }, () => {})
  )
  assert.throws(() =>
    selectQualifiedReleaseImages(envelope, { ...expected, recordSha256: "f".repeat(64) }, () => {})
  )
  const invalid = fixture({ ...record, fleet: { ...record.fleet, workerDigest: "latest" } })
  assert.throws(() => selectQualifiedReleaseImages(invalid.envelope, invalid.expected, () => {}))
  const invalidSource = "not-an-immutable-revision"
  const invalidRevision = fixture({
    ...record,
    fleet: { ...record.fleet, productRevision: invalidSource },
    issuer: { ...record.issuer, source: invalidSource },
  })
  assert.throws(() =>
    selectQualifiedReleaseImages(
      invalidRevision.envelope,
      { ...invalidRevision.expected, source: invalidSource },
      () => {}
    )
  )
})

test("production selector rejects a foreign-key signed record without emitting images", () => {
  const { envelope, expected } = fixture()
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 })
  envelope.result = {
    algorithm: "RS256",
    keyId: runtimeQualificationKeyId,
    signature: sign("RSA-SHA256", Buffer.from(envelope.raw), privateKey).toString("base64"),
  }
  const directory = mkdtempSync(join(tmpdir(), "lyra-invalid-qualification-"))
  try {
    const output = join(directory, "output")
    const result = spawnSync(
      process.execPath,
      [".github/scripts/select-qualified-release-images.mjs"],
      {
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          RUNTIME_FLEET_QUALIFICATION: JSON.stringify(envelope),
          RUNTIME_FLEET_RECORD_SHA256: expected.recordSha256,
          SOURCE_SHA: source,
          SOURCE_TREE: tree,
          ENGINE_REVISION: engine,
        },
        encoding: "utf8",
      }
    )
    assert.notEqual(result.status, 0)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- owned temporary output
    assert.equal(existsSync(output), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("cold workflow uses only qualified images and rejects a conflicting build", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-azure.yml", "utf8"))
  const job = workflow.jobs["resolve-images"]
  const select = job.steps.find((step) => step.id === "select")
  assert.match(workflow.jobs.build.if, /inputs\.cold_release != true/)
  for (const checkedJob of [workflow.jobs["preflight-compatible-baseline"], job]) {
    const setup = checkedJob.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
    assert.equal(String(setup?.with?.["node-version"]), "24")
  }
  const directory = mkdtempSync(join(tmpdir(), "lyra-qualified-images-"))
  try {
    const output = join(directory, "output")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- executable in the owned temporary directory
    writeFileSync(
      join(directory, "node"),
      `#!/bin/sh
if [ "$1" = .github/scripts/select-qualified-release-images.mjs ]; then
  printf '%s\n' 'web_image=qualified-web' 'worker_image=qualified-worker' 'egress_proxy_image=qualified-proxy' "sandbox_digest=$FAKE_SANDBOX_DIGEST" >> "$GITHUB_OUTPUT"
fi
`,
      { mode: 0o700 }
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- executable in the owned temporary directory
    writeFileSync(join(directory, "git"), "#!/bin/sh\nprintf '%040d\\n' 0\n", { mode: 0o700 })
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      COLD_RELEASE: "true",
      HELD_RECOVERY: "false",
      PAIRED_PREPARED: "false",
      PREPARED_RESULT: "skipped",
      FAKE_SANDBOX_DIGEST: digest("4"),
    }
    const good = spawnSync("bash", ["-e", "-c", select.run], {
      env: { ...env, BUILD_RESULT: "skipped" },
      encoding: "utf8",
    })
    assert.equal(good.status, 0, good.stderr)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- owned temporary output
    const lines = readFileSync(output, "utf8")
    assert.match(lines, /web_image=qualified-web/)
    assert.match(lines, /worker_image=qualified-worker/)
    assert.match(lines, /egress_proxy_image=qualified-proxy/)
    assert.ok(lines.includes(`sandbox_digest=${digest("4")}`))
    const conflicting = spawnSync("bash", ["-e", "-c", select.run], {
      env: { ...env, BUILD_RESULT: "success" },
      encoding: "utf8",
    })
    assert.notEqual(conflicting.status, 0)
    assert.match(
      workflow.jobs.deploy.if,
      /needs\.verify-built-worker-image\.outputs\.cold_sandbox_image/
    )
    assert.match(workflow.jobs.deploy.if, /needs\.resolve-images\.outputs\.sandbox_digest/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
