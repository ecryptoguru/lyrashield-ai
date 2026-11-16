import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, it, expect } from "vitest"
import { readSourceTree } from "@lyrashield/runtime-control"
import {
  verifyNativeEngineResult,
  isVerifiedNativeEngineResult,
  type NativeEngineResultProof,
  type NativeEngineOutput,
} from "./native-engine-result"

const roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})
const blob = (value: string) => {
  const bytes = Buffer.from(value)
  return {
    bytes: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  }
}
const expected = {
  operationId: "operation-one",
  attemptId: "attempt-one",
  workspaceId: "workspace-one",
  scanId: "scan-one",
  authorityEpochId: "epoch-one",
  productRevision: "a".repeat(40),
  engineRevision: "b".repeat(40),
  sourceRevision: "c".repeat(40),
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lyrashield-native-result-fixture-"))
  roots.push(root)
  mkdirSync(join(root, "empty"), { mode: 0o700 })
  writeFileSync(join(root, "app.js"), "const x=1", { mode: 0o600 })
  const run = JSON.parse(
    readFileSync(join(__dirname, "../../engine/fixtures/run-json-1.1/run.json"), "utf8")
  )
  run.run_name = expected.scanId
  run.run_id = expected.scanId
  const output: NativeEngineOutput = {
    schema: "lyrashield-native-engine-output/1",
    action: {
      phase: "EXECUTOR_CREATE",
      operationId: expected.operationId,
      attemptId: expected.attemptId,
      workspaceId: expected.workspaceId,
      scanId: expected.scanId,
      authorityEpochId: expected.authorityEpochId,
      authorityRevision: 1,
      authorityChecksum: "d".repeat(64),
      actionChecksum: "e".repeat(64),
      commandId: "command-one",
      executorKey: "engine",
    },
    guardId: "guard-one",
    ownership: {
      kind: "container",
      executorKey: "engine",
      ownershipId: "ownership-one",
      containerId: "f".repeat(64),
    },
    productRevision: expected.productRevision,
    engineRevision: expected.engineRevision,
    engineImageDigest: `sha256:${"1".repeat(64)}`,
    startedAt: "2026-11-14T00:00:00.000Z",
    finishedAt: "2026-11-14T00:01:00.000Z",
    exitCode: 0,
    source: {
      revision: expected.sourceRevision,
      stagedTreeDigest: readSourceTree(root, { ownerUid: process.getuid!(), immutable: false })
        .stagedTreeDigest,
      directories: ["empty"],
      files: [{ path: "app.js", ...blob("const x=1") }],
    },
    artifacts: {
      "run.json": blob(JSON.stringify(run)),
      "vulnerabilities.json": blob("[]"),
      "coverage.json": "ABSENT",
      "threat_model.json": "ABSENT",
      "http_exchanges.json": "ABSENT",
    },
  }
  const seal = () => {
    const bytes = Buffer.from(JSON.stringify(output))
    const proof: NativeEngineResultProof = {
      schema: "lyrashield-root-worker-result-proof/1",
      authority: {},
      action: output.action,
      guardId: output.guardId,
      ownership: output.ownership,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      totalBytes: bytes.length,
    }
    return { bytes, proof }
  }
  return { output, seal }
}
describe("independently root-bound native output", () => {
  it("reuses optional artifact incomplete semantics and exact source bytes", () => {
    const { seal } = fixture(),
      { bytes, proof } = seal()
    const result = verifyNativeEngineResult(bytes, proof, expected)
    roots.push(result.engineResult.sourceCheckoutPath!)
    expect(isVerifiedNativeEngineResult(result)).toBe(true)
    expect(result.engineResult.output.scopedCoverage).toBeNull()
    expect(result.engineResult.output.threatModels).toBeNull()
    expect(result.engineResult.output.httpExchangeExport).toBeNull()
    expect(readFileSync(join(result.engineResult.sourceCheckoutPath!, "app.js"), "utf8")).toBe(
      "const x=1"
    )
    result.verifySource()
    writeFileSync(join(result.engineResult.sourceCheckoutPath!, "app.js"), "changed", {
      mode: 0o600,
    })
    expect(() => result.verifySource()).toThrow("changed")
  })
  it.each(["ABSENT", "UNREADABLE", "CAPPED"])("rejects required %s output", (state) => {
    const { output, seal } = fixture()
    output.artifacts["run.json"] = state
    const { bytes, proof } = seal()
    expect(() => verifyNativeEngineResult(bytes, proof, expected)).toThrow("required output")
  })
  it("rejects broker-forged bytes even when scope looks right", () => {
    const { seal } = fixture(),
      { bytes, proof } = seal()
    expect(() =>
      verifyNativeEngineResult(Buffer.concat([bytes, Buffer.from(" ")]), proof, expected)
    ).toThrow("proof mismatch")
  })
  it("rejects cross-attempt or missing immutable source", () => {
    const { output, seal } = fixture()
    let sealed = seal()
    expect(() =>
      verifyNativeEngineResult(sealed.bytes, sealed.proof, {
        ...expected,
        attemptId: "other-attempt",
      })
    ).toThrow("scope")
    output.source = null
    sealed = seal()
    expect(() => verifyNativeEngineResult(sealed.bytes, sealed.proof, expected)).toThrow(
      "source unavailable"
    )
  })
  it("rejects traversal and mismatched source hashes", () => {
    const { output, seal } = fixture()
    output.source!.files[0]!.path = "../escape"
    let sealed = seal()
    expect(() => verifyNativeEngineResult(sealed.bytes, sealed.proof, expected)).toThrow()
    output.source!.files[0]!.path = "app.js"
    output.source!.stagedTreeDigest = "0".repeat(64)
    sealed = seal()
    expect(() => verifyNativeEngineResult(sealed.bytes, sealed.proof, expected)).toThrow(
      "tree changed"
    )
  })
})
