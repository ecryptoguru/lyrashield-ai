import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { diffChecksum } from "./checksum"

export const COMPOSER_FIX_MAX_BYTES = 512 * 1024
const stableVersion = z.string().regex(/^v?\d+\.\d+\.\d+$/)
const lockPath = z
  .string()
  .max(300)
  .refine((value) => {
    const segments = value.split("/")
    return (
      segments.pop() === "composer.lock" &&
      segments.every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(segment))
    )
  }, "Composer lock path must be a safe repository-relative path")
const bindingFields = {
  workspaceId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(128),
  findingId: z.string().min(1).max(128),
  proposalId: z.string().min(1).max(128),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
}
export const ComposerFixArtifactSchema = z
  .object({
    version: z.literal("composer-fix/1"),
    ...bindingFields,
    manifestPath: z.string().max(300),
    lockPath,
    packageName: z
      .string()
      .max(200)
      .regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/),
    fromVersion: stableVersion,
    toVersion: stableVersion,
    before: z.string().max(COMPOSER_FIX_MAX_BYTES),
    after: z.string().max(COMPOSER_FIX_MAX_BYTES),
    diff: z.string().max(COMPOSER_FIX_MAX_BYTES * 2),
    diffChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    resolverImage: z.string().regex(/^composer@sha256:[a-f0-9]{64}$/),
    checks: z
      .object({
        network: z.literal("none"),
        scripts: z.literal(false),
        plugins: z.literal(false),
        install: z.literal(false),
        lockValidated: z.literal(true),
      })
      .strict(),
    compatibility: z.literal("customer-tests-required"),
  })
  .strict()
export type ComposerFixArtifact = z.infer<typeof ComposerFixArtifactSchema>
export type ComposerFixBindings = z.infer<z.ZodObject<typeof bindingFields>>

export function parseComposerFixArtifact(content: string): ComposerFixArtifact {
  if (Buffer.byteLength(content) > COMPOSER_FIX_MAX_BYTES * 4)
    throw new Error("Composer fix artifact exceeds size limit")
  return ComposerFixArtifactSchema.parse(JSON.parse(content))
}

/** Linear single-hunk diff: dependency locks must never allocate an LCS matrix. */
export function buildComposerUpdateDiff(path: string, before: string, after: string): string {
  if (
    !lockPath.safeParse(path).success ||
    [before, after].some((x) => Buffer.byteLength(x) > COMPOSER_FIX_MAX_BYTES)
  )
    throw new Error("Composer lock input exceeds its safe scope or size")
  if (before === after) return ""
  const a = before.split("\n"),
    b = after.split("\n")
  let prefix = 0,
    suffix = 0
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++
  const start = Math.max(0, prefix - 3),
    tail = Math.min(3, suffix)
  const oldEnd = a.length - suffix,
    newEnd = b.length - suffix
  const body = [
    ...a.slice(start, prefix).map((x) => ` ${x}`),
    ...a.slice(prefix, oldEnd).map((x) => `-${x}`),
    ...b.slice(prefix, newEnd).map((x) => `+${x}`),
    ...a.slice(oldEnd, oldEnd + tail).map((x) => ` ${x}`),
  ]
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start + 1},${oldEnd - start + tail} +${start + 1},${newEnd - start + tail} @@`,
    ...body,
  ].join("\n")
}

const lockSchema = z
  .object({
    packages: z.array(z.record(z.string(), z.unknown())).max(500),
    "packages-dev": z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  })
  .catchall(z.unknown())
function versionParts(value: string): number[] {
  return value.replace(/^v/, "").split(".").map(Number)
}
function isUpgrade(before: string, after: string): boolean {
  const a = versionParts(before),
    b = versionParts(after)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i]! > a[i]!
  }
  return false
}

/** Validate bytes and semantic scope independently of the package-manager producer. */
export function checkComposerFixArtifact(
  input: unknown,
  bindings: ComposerFixBindings
): ComposerFixArtifact {
  const value = ComposerFixArtifactSchema.parse(input)
  for (const key of Object.keys(bindingFields) as Array<keyof ComposerFixBindings>) {
    if (value[key] !== bindings[key]) throw new Error("Composer fix binding mismatch")
  }
  if (value.manifestPath !== value.lockPath.replace(/\.lock$/, ".json"))
    throw new Error("Composer manifest path mismatch")
  if (!isUpgrade(value.fromVersion, value.toVersion))
    throw new Error("Composer fix must upgrade the affected release")
  if (
    value.diff !== buildComposerUpdateDiff(value.lockPath, value.before, value.after) ||
    value.diffChecksum !== diffChecksum(value.diff)
  )
    throw new Error("Composer fix bytes do not match the resolver receipt")
  const before = lockSchema.parse(JSON.parse(value.before)),
    after = lockSchema.parse(JSON.parse(value.after))
  let upgrades = 0
  for (const section of ["packages", "packages-dev"] as const) {
    const a = before[section] ?? [],
      b = after[section] ?? []
    if (a.length !== b.length) throw new Error("Composer fix changed the dependency set")
    const names = new Set<string>()
    for (const pkg of a) {
      if (typeof pkg.name !== "string" || names.has(pkg.name))
        throw new Error("Invalid Composer package identity")
      names.add(pkg.name)
      const next = b.find((x) => x.name === pkg.name)
      if (!next) throw new Error("Composer package disappeared")
      if (pkg.name === value.packageName) {
        if (
          typeof pkg.version !== "string" ||
          typeof next.version !== "string" ||
          pkg.version.replace(/^v/, "") !== value.fromVersion.replace(/^v/, "") ||
          next.version.replace(/^v/, "") !== value.toVersion.replace(/^v/, "")
        )
          throw new Error("Composer package release mismatch")
        upgrades++
      } else if (!isDeepStrictEqual(pkg, next))
        throw new Error("Composer fix changed an unrelated package")
    }
  }
  if (upgrades !== 1) throw new Error("Composer fix has no unique affected package")
  const metadata = (lock: typeof before) =>
    Object.fromEntries(
      Object.entries(lock).filter(
        ([key]) => !["packages", "packages-dev", "plugin-api-version"].includes(key)
      )
    )
  if (!isDeepStrictEqual(metadata(before), metadata(after)))
    throw new Error("Composer lock metadata changed")
  return value
}
