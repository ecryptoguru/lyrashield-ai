import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import {
  disposableExecutionContextSchema,
  preparationProofFailure,
} from "./trusted-preparation-proof"
const fixtureSchema = z
  .object({
    databaseContainer: z.string().regex(/^[a-f0-9]{64}$/),
    providerContainer: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.string().regex(/^[a-f0-9]{32,64}$/),
    relayPid: z.number().int().positive(),
    relayPortFile: z.string().startsWith("/"),
    providerRelayPid: z.number().int().positive(),
    providerRelayPortFile: z.string().startsWith("/"),
    database: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/),
  })
  .strict()
export type DisposablePreparationFixture = z.infer<typeof fixtureSchema>
const observer = fileURLToPath(
  new URL(
    "../../../ops/prototypes/dispatch-plan-test/observe_execution_context.py",
    import.meta.url
  )
)
export function disposableObservationCommand(
  file: string,
  args: string[],
  maximum = 128 * 1024
): string {
  try {
    return execFileSync(file, args, {
      timeout: 30_000,
      maxBuffer: maximum,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString("utf8")
      .trimEnd()
  } catch {
    return preparationProofFailure()
  }
}
export function observeDisposableExecutionContext(input: DisposablePreparationFixture) {
  const f = fixtureSchema.parse(input)
  const raw = disposableObservationCommand("python3", [
    observer,
    "--database-container",
    f.databaseContainer,
    "--provider-container",
    f.providerContainer,
    "--owner",
    f.owner,
    "--relay-pid",
    String(f.relayPid),
    "--relay-port-file",
    f.relayPortFile,
    "--provider-relay-pid",
    String(f.providerRelayPid),
    "--provider-relay-port-file",
    f.providerRelayPortFile,
    "--database",
    f.database,
  ])
  const evidence = JSON.parse(raw)
  if (
    evidence.schema !== "lyrashield-disposable-execution-context/1" ||
    evidence.purpose !== "disposable-execution-observation"
  )
    preparationProofFailure()
  return { context: disposableExecutionContextSchema.parse(evidence.context), evidence }
}
export function inspectDisposablePreparationImage(
  ref: string,
  entrypoint: string[],
  expectedRevision: string,
  expectedSource: string
) {
  const parsed = JSON.parse(disposableObservationCommand("docker", ["image", "inspect", ref]))
  if (
    parsed.length !== 1 ||
    parsed[0]?.Os !== "linux" ||
    !/^sha256:[a-f0-9]{64}$/.test(parsed[0]?.Id)
  )
    preparationProofFailure()
  const image = parsed[0]
  if (
    image.Config?.Labels?.["org.opencontainers.image.revision"] !== expectedRevision ||
    image.Config?.Labels?.["org.opencontainers.image.source"] !== expectedSource
  )
    preparationProofFailure()
  const digest = ref.slice(ref.lastIndexOf("@") + 1)
  if (image.Id !== digest && !(image.RepoDigests ?? []).includes(ref)) preparationProofFailure()
  if (canonicalJson(image.Config?.Entrypoint ?? []) !== canonicalJson(entrypoint))
    preparationProofFailure()
  return {
    reference: ref,
    configId: image.Id,
    repoDigests: [...(image.RepoDigests ?? [])].sort(),
    entrypoint,
  }
}
function stagedFileChecksum(path: string, maximum: number) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated staged leaf; no-follow descriptor prevents pathname substitution
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maximum ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o022) !== 0
    )
      preparationProofFailure()
    const bytes = Buffer.allocUnsafe(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    if (
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      preparationProofFailure()
    return createHash("sha256").update(bytes.subarray(0, length)).digest("hex")
  } finally {
    closeSync(fd)
  }
}
export function readDisposableSourceReceipt(root: string, revision: string) {
  if (!root.startsWith("/") || !/^[a-f0-9]{40}$/.test(revision)) preparationProofFailure()
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- protected operator-installed staged root; no worker selects it
  const metadata = lstatSync(root)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o022) !== 0
  )
    preparationProofFailure()
  if (
    disposableObservationCommand("git", [
      "--no-replace-objects",
      "-C",
      root,
      "rev-parse",
      "HEAD",
    ]) !== revision ||
    disposableObservationCommand("git", [
      "--no-replace-objects",
      "-C",
      root,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    ]) !== ""
  )
    preparationProofFailure()
  const paths = disposableObservationCommand("git", [
    "--no-replace-objects",
    "-C",
    root,
    "ls-files",
    "-z",
  ])
    .split("\0")
    .filter(Boolean)
  if (paths.length === 0 || paths.length > 10000) preparationProofFailure()
  let total = 0
  const entries = paths.sort().map((path) => {
    if (path.startsWith("/") || path.split("/").includes("..")) preparationProofFailure()
    const file = join(root, path)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- git-owned relative leaf inside validated private staged source
    const stat = lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 5 * 1024 * 1024
    )
      preparationProofFailure()
    total += stat.size
    if (total > 20 * 1024 * 1024) preparationProofFailure()
    const checksum = stagedFileChecksum(file, 5 * 1024 * 1024)
    return {
      path,
      bytes: stat.size,
      checksum,
    }
  })
  return { revision, entries, stagedTreeDigest: sha256Hex(canonicalJson(entries)) }
}
