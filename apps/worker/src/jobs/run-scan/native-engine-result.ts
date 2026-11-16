/* eslint-disable security/detect-non-literal-fs-filename -- Paths come only from a validated bounded archive materialized in a fresh private directory. */
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  authorityActionSchema,
  resourceOwnershipSchema,
  readSourceTree,
} from "@lyrashield/runtime-control"
import { parseEngineOutput } from "../../engine/output-parser"
import type { EngineRunResult } from "../../engine/runner"

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    const parts = value.split("/")
    return (
      parts.length <= 64 &&
      parts.every(
        (part) => part !== "" && part !== "." && part !== ".." && !/[\\\x00-\x1f\x7f]/.test(part)
      )
    )
  })
const blob = z
  .object({ bytes: z.number().int().nonnegative(), checksum, base64: z.string() })
  .strict()
const artifact = z.union([blob, z.enum(["ABSENT", "UNREADABLE", "CAPPED"])])
const outputSchema = z
  .object({
    schema: z.literal("lyrashield-native-engine-output/1"),
    action: authorityActionSchema,
    guardId: id,
    ownership: resourceOwnershipSchema,
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
    engineImageDigest: digest,
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    exitCode: z.number().int().min(0).max(255),
    source: z
      .object({
        revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        stagedTreeDigest: checksum,
        directories: z.array(path).max(10000),
        files: z.array(blob.extend({ path }).strict()).max(10000),
      })
      .strict()
      .nullable(),
    artifacts: z
      .object({
        "run.json": artifact,
        "vulnerabilities.json": artifact,
        "coverage.json": artifact,
        "threat_model.json": artifact,
        "http_exchanges.json": artifact,
      })
      .strict(),
  })
  .strict()
export type NativeEngineOutput = z.infer<typeof outputSchema>
export const nativeEngineResultProofSchema = z
  .object({
    schema: z.literal("lyrashield-root-worker-result-proof/1"),
    // The protected installation loader validates this descriptor against its own installed authority.
    authority: z.unknown(),
    action: authorityActionSchema,
    guardId: id,
    ownership: resourceOwnershipSchema,
    sha256: digest,
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(96 * 1024 * 1024),
  })
  .strict()
export type NativeEngineResultProof = z.infer<typeof nativeEngineResultProofSchema>
export interface VerifiedNativeEngineResult {
  readonly action: z.infer<typeof authorityActionSchema>
  readonly engineImageDigest: string
  readonly engineResult: EngineRunResult
  readonly startedAtMs: number
  readonly finishedAtMs: number
  verifySource(): void
  cleanup(): void
}
const verified = new WeakSet<object>()
export function isVerifiedNativeEngineResult(value: VerifiedNativeEngineResult): boolean {
  return verified.has(value)
}
function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return JSON.stringify(left) === JSON.stringify(right)
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>,
      b = right as Record<string, unknown>
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    )
  }
  return left === right
}
function decode(value: z.infer<typeof blob>, limit: number): Buffer {
  if (
    value.bytes > limit ||
    value.base64.length > 4 * Math.ceil(limit / 3) ||
    /[^A-Za-z0-9+/=]/.test(value.base64)
  )
    throw new Error("Native result blob unavailable")
  const bytes = Buffer.from(value.base64, "base64")
  if (
    bytes.length !== value.bytes ||
    bytes.toString("base64") !== value.base64 ||
    createHash("sha256").update(bytes).digest("hex") !== value.checksum
  )
    throw new Error("Native result checksum mismatch")
  return bytes
}
/** The proof must be obtained independently from the root worker socket, never from the byte transport. */
export function verifyNativeEngineResult(
  bytes: Buffer,
  proof: NativeEngineResultProof,
  expected: {
    operationId: string
    attemptId: string
    workspaceId: string
    scanId: string
    authorityEpochId: string
    productRevision: string
    engineRevision: string
    sourceRevision: string
  }
): VerifiedNativeEngineResult {
  if (
    bytes.length > 96 * 1024 * 1024 ||
    bytes.length !== proof.totalBytes ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== proof.sha256
  )
    throw new Error("Native result proof mismatch")
  const output = outputSchema.parse(JSON.parse(bytes.toString("utf8")))
  if (
    !equal(output.action, proof.action) ||
    output.guardId !== proof.guardId ||
    !equal(output.ownership, proof.ownership) ||
    output.action.phase !== "EXECUTOR_CREATE" ||
    output.action.executorKey !== "engine" ||
    output.ownership.executorKey !== "engine" ||
    output.ownership.kind !== "container" ||
    !output.ownership.containerId
  )
    throw new Error("Native result ownership mismatch")
  for (const key of [
    "operationId",
    "attemptId",
    "workspaceId",
    "scanId",
    "authorityEpochId",
  ] as const)
    if (output.action[key] !== expected[key]) throw new Error("Native result scope mismatch")
  if (
    output.productRevision !== expected.productRevision ||
    output.engineRevision !== expected.engineRevision ||
    !output.source ||
    output.source.revision !== expected.sourceRevision
  )
    throw new Error("Native result source unavailable")
  const startedAtMs = Date.parse(output.startedAt),
    finishedAtMs = Date.parse(output.finishedAt)
  if (
    finishedAtMs < startedAtMs ||
    finishedAtMs > Date.now() + 1000 ||
    finishedAtMs - startedAtMs > 24 * 60 * 60 * 1000
  )
    throw new Error("Native result timing unavailable")
  const source = output.source
  if (source.directories.length + source.files.length > 10000)
    throw new Error("Native source exceeds bound")
  const root = mkdtempSync(join(tmpdir(), "lyrashield-native-result-"))
  try {
    const names = new Set<string>()
    const directories = new Set(source.directories)
    let total = 0
    for (const name of [...source.directories, ...source.files.map((file) => file.path)]) {
      if (names.has(name)) throw new Error("Native source duplicate path")
      names.add(name)
      const parts = name.split("/")
      for (let i = 1; i < parts.length; i++)
        if (!directories.has(parts.slice(0, i).join("/")))
          throw new Error("Native source parent unavailable")
    }
    for (const directory of [...source.directories].sort(
      (a, b) => a.split("/").length - b.split("/").length
    ))
      mkdirSync(join(root, directory), { mode: 0o700 })
    for (const file of source.files) {
      const content = decode(file, 5 * 1024 * 1024)
      total += content.length
      if (total > 20 * 1024 * 1024) throw new Error("Native source exceeds bound")
      writeFileSync(join(root, file.path), content, { mode: 0o600, flag: "wx" })
    }
    const verifySource = () => {
      if (
        readSourceTree(root, { ownerUid: process.getuid?.() ?? -1, immutable: false })
          .stagedTreeDigest !== source.stagedTreeDigest
      )
        throw new Error("Native source tree changed")
    }
    verifySource()
    const text = (
      name: keyof typeof output.artifacts,
      limit: number
    ): string | null | undefined => {
      const entry = output.artifacts[name]
      return entry === "ABSENT"
        ? undefined
        : typeof entry === "string"
          ? null
          : decode(entry, limit).toString("utf8")
    }
    const run = text("run.json", 1024 * 1024),
      vulnerabilities = text("vulnerabilities.json", 10 * 1024 * 1024)
    // Required missing artifacts cannot become a successful empty review.
    if (typeof run !== "string" || typeof vulnerabilities !== "string")
      throw new Error("Native required output unavailable")
    const parsed = parseEngineOutput(
      vulnerabilities,
      run,
      {
        coverageRaw: text("coverage.json", 256 * 1024),
        threatModelsRaw: text("threat_model.json", 32 * 1024 * 1024),
        httpExchangesRaw: text("http_exchanges.json", 2 * 1024 * 1024),
      },
      { expectedRunName: expected.scanId }
    )
    const result: VerifiedNativeEngineResult = Object.freeze({
      action: output.action,
      engineImageDigest: output.engineImageDigest,
      startedAtMs,
      finishedAtMs,
      engineResult: {
        exitCode: output.exitCode,
        cancelled: false,
        timedOut: false,
        output: parsed,
        sourceCheckoutPath: root,
        sourceRevision: source.revision,
        sandboxRemoved: true,
      },
      verifySource,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    })
    verified.add(result)
    return result
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
