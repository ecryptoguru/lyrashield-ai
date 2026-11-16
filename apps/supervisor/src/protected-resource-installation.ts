/* eslint-disable security/detect-non-literal-fs-filename -- Fixed protected roots and schema-validated checksum/grant selectors only. */
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { createHash } from "node:crypto"
import {
  canonicalJson,
  sha256Hex,
  executorResourceDescriptorSchema,
  readSourceTree,
  type ExecutorResourceDescriptor,
} from "@lyrashield/runtime-control"

const CONTROL_ROOT = "/etc/lyrashield/control"
const INPUT_ROOT = "/var/lib/lyrashield/control/inputs"
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const installationSchema = z
  .object({
    schema: z.literal("lyrashield-protected-resource-installation/1"),
    attemptId: z.string().min(3).max(192),
    stagingRecordChecksum: hash,
    hostPolicyChecksum: hash,
    issuerKeyHash: hash,
    descriptorChecksums: z.array(hash).min(1).max(2),
    expiresAt: z.string().datetime({ offset: true }),
    network: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    networkPolicyChecksum: hash,
    inputs: z
      .array(
        z
          .object({
            grantId: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/)
              .refine((value) => !value.includes("..")),
            checksum: hash,
            kind: z.enum(["source", "attachments", "relay", "egress"]),
          })
          .strict()
      )
      .max(4),
  })
  .strict()

async function protectedPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path)
  if (
    info.uid !== 0 ||
    info.isSymbolicLink() ||
    (info.mode & 0o027) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile())
  )
    throw new Error("Protected resource installation permissions are invalid")
}

async function protectedBytes(path: string, maximum: number): Promise<Buffer> {
  await protectedPath(path, false)
  if ((await lstat(path)).size > maximum)
    throw new Error("Protected resource file exceeds the bound")
  const bytes = await readFile(path)
  if (bytes.byteLength > maximum) throw new Error("Protected resource file exceeds the bound")
  return bytes
}

/** Fixed root-owned catalog; no host path is accepted from an executor request. */
export async function loadProtectedResourceInstallation(
  descriptor: ExecutorResourceDescriptor,
  attemptId: string,
  network: string
): Promise<{
  args: string[]
  mounts: Array<{ source: string; target: string }>
  descriptorChecksum: string
}> {
  descriptor = executorResourceDescriptorSchema.parse(descriptor)
  const descriptorChecksum = sha256Hex(canonicalJson(descriptor))
  await protectedPath("/etc/lyrashield", true)
  await protectedPath(CONTROL_ROOT, true)
  await protectedPath(join(CONTROL_ROOT, "resources"), true)
  const path = join(CONTROL_ROOT, "resources", `${descriptor.stagingRecordChecksum}.json`)
  const raw = (await protectedBytes(path, 16_384)).toString("utf8")
  const installation = installationSchema.parse(JSON.parse(raw))
  if (
    Buffer.byteLength(raw) > 16_384 ||
    canonicalJson(installation) !== raw ||
    installation.attemptId !== attemptId ||
    installation.stagingRecordChecksum !== descriptor.stagingRecordChecksum ||
    installation.hostPolicyChecksum !== descriptor.hostPolicyChecksum ||
    installation.issuerKeyHash !== descriptor.issuerKeyHash ||
    !installation.descriptorChecksums.includes(descriptorChecksum) ||
    Date.parse(installation.expiresAt) <= Date.now() ||
    installation.network !== network ||
    network === "host" ||
    network === "bridge" ||
    installation.networkPolicyChecksum !== descriptor.isolation.networkPolicyChecksum
  )
    throw new Error("Protected resource installation does not match approved execution authority")
  const mounts = await installedMounts(descriptor, installation)
  const seccompRoot = join(CONTROL_ROOT, "seccomp")
  await protectedPath(seccompRoot, true)
  const seccompPath = join(seccompRoot, `${descriptor.isolation.seccompPolicyChecksum}.json`)
  const seccomp = await protectedBytes(seccompPath, 262_144)
  if (bytesHash(seccomp) !== descriptor.isolation.seccompPolicyChecksum)
    throw new Error("Protected seccomp policy checksum is invalid")
  const args = [
    "--user",
    `${descriptor.uid}:${descriptor.gid}`,
    "--workdir",
    descriptor.workdir,
    "--shm-size",
    `${descriptor.isolation.shmMb}m`,
    "--security-opt",
    `seccomp=${seccompPath}`,
    "--security-opt",
    `apparmor=${descriptor.isolation.appArmorProfile}`,
    "--label",
    `lyrashield.supervisor.descriptor=${descriptorChecksum}`,
    "--tmpfs",
    `${descriptor.workspaceRoot}:rw,nosuid,nodev,uid=${descriptor.uid},gid=${descriptor.gid},mode=0750`,
  ]
  for (const mount of mounts)
    args.push("--mount", `type=bind,source=${mount.source},target=${mount.target},readonly`)
  return { args, mounts, descriptorChecksum }
}

async function installedMounts(
  descriptor: ExecutorResourceDescriptor,
  installation: z.infer<typeof installationSchema>
): Promise<Array<{ source: string; target: string }>> {
  const resources = [
    descriptor.source && {
      kind: "source",
      grantId: descriptor.source.grantId,
      checksum: descriptor.source.stagedTreeDigest,
      target: descriptor.source.root,
    },
    descriptor.attachments && {
      kind: "attachments",
      grantId: descriptor.attachments.grantId,
      checksum: descriptor.attachments.manifestChecksum,
      target: descriptor.attachments.root,
    },
    descriptor.relay && {
      kind: "relay",
      grantId: descriptor.relay.grantId,
      checksum: descriptor.relay.grantChecksum,
      target: descriptor.relay.mountRoot,
    },
    {
      kind: "egress",
      grantId: descriptor.egress.grantId,
      checksum: descriptor.egress.policyChecksum,
      target: descriptor.egress.policyPath,
    },
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  if (
    resources.length !== installation.inputs.length ||
    new Set(installation.inputs.map((entry) => entry.grantId)).size !== resources.length
  )
    throw new Error("Protected resource grant set is invalid")
  await protectedPath("/var/lib/lyrashield", true)
  await protectedPath("/var/lib/lyrashield/control", true)
  await protectedPath(INPUT_ROOT, true)
  const mounts: Array<{ source: string; target: string }> = []
  for (const resource of resources) {
    if (
      !installation.inputs.some(
        (entry) =>
          entry.kind === resource.kind &&
          entry.grantId === resource.grantId &&
          entry.checksum === resource.checksum
      )
    )
      throw new Error("Protected resource grant is unavailable")
    const grantRoot = join(INPUT_ROOT, resource.grantId)
    await protectedPath(grantRoot, true)
    const source = resource.kind === "egress" ? join(grantRoot, "policy.json") : grantRoot
    await protectedPath(source, resource.kind !== "egress")
    if (resource.kind === "egress") {
      const bytes = await protectedBytes(source, 65_536)
      if (bytesHash(bytes) !== resource.checksum)
        throw new Error("Protected egress policy checksum is invalid")
    }
    if (resource.kind === "source") {
      const observed = readSourceTree(source, { ownerUid: 0, immutable: true })
      if (observed.stagedTreeDigest !== resource.checksum)
        throw new Error("Protected source tree checksum is invalid")
    }
    if (resource.kind === "attachments") {
      const manifest = descriptor.attachments!
      const observed = readSourceTree(source, { ownerUid: 0, immutable: true })
      if (
        sha256Hex(canonicalJson(manifest.entries)) !== manifest.manifestChecksum ||
        observed.entries.length !== manifest.entries.length ||
        !manifest.entries.every((entry) =>
          observed.entries.some(
            (file) =>
              file.path === entry.containerPath.slice("/input/attachments/".length) &&
              file.bytes === entry.byteLength &&
              file.checksum === entry.checksum
          )
        )
      )
        throw new Error("Protected attachment bytes do not match the approved manifest")
    }
    mounts.push({ source, target: resource.target })
  }
  return mounts
}
