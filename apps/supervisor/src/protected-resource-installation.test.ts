import { beforeEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import {
  canonicalJson,
  executorResourceDescriptorSchema,
  executorSpecSchema,
  sha256Hex,
} from "@lyrashield/runtime-control"
import { loadProtectedResourceInstallation } from "./protected-resource-installation"
import { verifyProtectedContainer } from "./protected-container-verification"

const io = vi.hoisted(() => ({ lstat: vi.fn(), readFile: vi.fn(), exec: vi.fn(), source: vi.fn() }))
vi.mock("@lyrashield/runtime-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/runtime-control")>()),
  readSourceTree: io.source,
}))
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  lstat: io.lstat,
  readFile: io.readFile,
}))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: io.exec,
  }),
}))
const bytesHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const egress = Buffer.from('{"allow":[]}')
const seccomp = Buffer.from('{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}')
const hash = "b".repeat(64)
const descriptor = executorResourceDescriptorSchema.parse({
  schema: "lyrashield-executor-resources/1",
  hostPolicyChecksum: hash,
  imageDigest: `sha256:${"a".repeat(64)}`,
  uid: 1000,
  gid: 1000,
  workspaceRoot: "/workspace",
  workdir: "/workspace",
  source: null,
  attachments: null,
  relay: null,
  egress: {
    grantId: "egress-1",
    policyPath: "/run/lyrashield-egress/policy.json",
    policyChecksum: bytesHash(egress),
    authorizedHosts: [],
    relayRequired: false,
    readOnly: true,
  },
  scratchRoot: "/workspace/.attachments-scratch",
  stagingRecordChecksum: hash,
  issuerKeyHash: hash,
  isolation: {
    networkPolicyChecksum: hash,
    seccompPolicyChecksum: bytesHash(seccomp),
    appArmorProfile: "fixture-profile",
    dropCapabilities: "ALL",
    noNewPrivileges: true,
    readOnlyRoot: true,
    shmMb: 512,
  },
})
let catalog: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks()
  io.source.mockReturnValue({ stagedTreeDigest: hash, entries: [] })
  catalog = {
    schema: "lyrashield-protected-resource-installation/1",
    attemptId: "attempt-1",
    stagingRecordChecksum: hash,
    hostPolicyChecksum: hash,
    issuerKeyHash: hash,
    descriptorChecksums: [sha256Hex(canonicalJson(descriptor))],
    expiresAt: "2099-01-01T00:00:00Z",
    network: "none",
    networkPolicyChecksum: hash,
    inputs: [{ kind: "egress", grantId: "egress-1", checksum: bytesHash(egress) }],
  }
  io.lstat.mockImplementation(async (path: string) => ({
    uid: 0,
    mode: path.endsWith(".json") ? 0o640 : 0o750,
    size: 1024,
    isSymbolicLink: () => false,
    isDirectory: () => !path.endsWith(".json"),
    isFile: () => path.endsWith(".json"),
  }))
  io.readFile.mockImplementation(async (path: string) =>
    path.includes("/resources/")
      ? Buffer.from(canonicalJson(catalog))
      : path.includes("/seccomp/")
        ? seccomp
        : egress
  )
})

it.each([true, false])(
  "rehashes immutable source bytes before granting a mount (match=%s)",
  async (match) => {
    const sourceDescriptor = executorResourceDescriptorSchema.parse({
      ...descriptor,
      source: {
        grantId: "source-1",
        root: "/workspace/source",
        revision: "c".repeat(40),
        stagedTreeDigest: hash,
        readOnly: true,
      },
    })
    catalog.descriptorChecksums = [sha256Hex(canonicalJson(sourceDescriptor))]
    catalog.inputs = [
      { kind: "source", grantId: "source-1", checksum: hash },
      { kind: "egress", grantId: "egress-1", checksum: bytesHash(egress) },
    ]
    io.source.mockReturnValue({ stagedTreeDigest: match ? hash : "d".repeat(64), entries: [] })
    const installed = loadProtectedResourceInstallation(sourceDescriptor, "attempt-1", "none")
    if (match)
      await expect(installed).resolves.toHaveProperty("mounts.0.target", "/workspace/source")
    else await expect(installed).rejects.toThrow("Protected source tree checksum is invalid")
    expect(io.source).toHaveBeenCalledWith("/var/lib/lyrashield/control/inputs/source-1", {
      ownerUid: 0,
      immutable: true,
    })
  }
)

it("builds only protected read-only grants and the approved identity/isolation arguments", async () => {
  const installed = await loadProtectedResourceInstallation(descriptor, "attempt-1", "none")
  expect(installed.mounts).toEqual([
    {
      source: "/var/lib/lyrashield/control/inputs/egress-1/policy.json",
      target: descriptor.egress.policyPath,
    },
  ])
  expect(installed.args).toEqual(
    expect.arrayContaining([
      "--user",
      "1000:1000",
      "--workdir",
      "/workspace",
      "--shm-size",
      "512m",
      `seccomp=/etc/lyrashield/control/seccomp/${bytesHash(seccomp)}.json`,
      "apparmor=fixture-profile",
      `type=bind,source=${installed.mounts[0]!.source},target=${descriptor.egress.policyPath},readonly`,
    ])
  )
})

it.each(["match", "bytes", "extra", "manifest"])(
  "rehashes approved attachment bytes before mounting (%s)",
  async (kind) => {
    const entries = [
      {
        id: "attachment-one",
        checksum: hash,
        byteLength: 3,
        contentType: "text/plain",
        filename: "proof.txt",
        containerPath: "/input/attachments/attachment-one-proof.txt",
      },
    ]
    const manifestChecksum =
      kind === "manifest" ? "f".repeat(64) : sha256Hex(canonicalJson(entries))
    const attachmentDescriptor = executorResourceDescriptorSchema.parse({
      ...descriptor,
      attachments: {
        grantId: "attachments-one",
        root: "/input/attachments",
        manifestChecksum,
        entries,
        readOnly: true,
      },
    })
    catalog.descriptorChecksums = [sha256Hex(canonicalJson(attachmentDescriptor))]
    catalog.inputs = [
      { kind: "attachments", grantId: "attachments-one", checksum: manifestChecksum },
      { kind: "egress", grantId: "egress-1", checksum: bytesHash(egress) },
    ]
    io.source.mockReturnValue({
      stagedTreeDigest: hash,
      entries: [
        {
          path: "attachment-one-proof.txt",
          bytes: 3,
          checksum: kind === "bytes" ? "d".repeat(64) : hash,
        },
        ...(kind === "extra" ? [{ path: ".ignored", bytes: 0, checksum: hash }] : []),
      ],
    })
    const result = loadProtectedResourceInstallation(attachmentDescriptor, "attempt-1", "none")
    if (kind === "match")
      await expect(result).resolves.toHaveProperty("mounts.0.target", "/input/attachments")
    else await expect(result).rejects.toThrow("Protected attachment bytes")
  }
)

it.each(["attempt", "descriptor", "expiry", "extra-input"])(
  "rejects a mismatched %s catalog before exposing host resources",
  async (kind) => {
    if (kind === "attempt") catalog.attemptId = "attempt-other"
    if (kind === "descriptor") catalog.descriptorChecksums = ["f".repeat(64)]
    if (kind === "expiry") catalog.expiresAt = "2000-01-01T00:00:00Z"
    if (kind === "extra-input") catalog.inputs = []
    await expect(
      loadProtectedResourceInstallation(descriptor, "attempt-1", "none")
    ).rejects.toThrow(/Protected resource/)
  }
)

it.each(["owner", "write", "symlink"])(
  "rejects an unsafe %s on the protected host path",
  async (kind) => {
    io.lstat.mockResolvedValue({
      uid: kind === "owner" ? 1000 : 0,
      mode: kind === "write" ? 0o770 : 0o750,
      size: 0,
      isSymbolicLink: () => kind === "symlink",
      isDirectory: () => true,
      isFile: () => false,
    })
    await expect(
      loadProtectedResourceInstallation(descriptor, "attempt-1", "none")
    ).rejects.toThrow(/permissions/)
    expect(io.readFile).not.toHaveBeenCalled()
  }
)

it("rejects substituted egress bytes", async () => {
  io.readFile.mockImplementation(async (path: string) =>
    path.includes("/resources/") ? Buffer.from(canonicalJson(catalog)) : Buffer.from("substituted")
  )
  await expect(loadProtectedResourceInstallation(descriptor, "attempt-1", "none")).rejects.toThrow(
    /egress policy checksum/
  )
})

it.each([
  "valid",
  "user",
  "mount",
  "network",
  "capabilities",
  "image",
  "privileged",
  "extra-network",
  "tmpfs",
])("independently verifies Docker configuration: %s", async (kind) => {
  const installed = await loadProtectedResourceInstallation(descriptor, "attempt-1", "none")
  const spec = executorSpecSchema.parse({
    kind: "container",
    image: `fixture@${descriptor.imageDigest}`,
    argv: [],
    env: {},
    network: "none",
    cpus: 1,
    memoryMb: 128,
    pidsLimit: 32,
    readOnly: true,
    grantEnvName: "LLM_API_KEY",
    resourceDescriptor: descriptor,
  })
  if (spec.kind !== "container") throw new Error("Container fixture missing")
  const networks: Record<string, object> = { none: {} }
  const ownership = {
    kind: "container" as const,
    executorKey: "engine" as const,
    ownershipId: `own_${"c".repeat(40)}`,
    containerId: "d".repeat(64),
  }
  const actual = {
    Id: ownership.containerId,
    Config: {
      Image: spec.image,
      User: "1000:1000",
      WorkingDir: "/workspace",
      Labels: {
        "lyrashield.supervisor.ownership": ownership.ownershipId,
        "lyrashield.supervisor.descriptor": installed.descriptorChecksum,
      },
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      Init: true,
      PidMode: "",
      IpcMode: "private",
      CapAdd: null,
      Devices: [],
      DeviceRequests: null,
      PublishAllPorts: false,
      PortBindings: null,
      Tmpfs: {
        "/workspace": "rw,nosuid,nodev,uid=1000,gid=1000,mode=0750",
        "/tmp": "rw,noexec,nosuid,nodev,size=256m",
      },
      Memory: 128 * 1048576,
      NanoCpus: 1000000000,
      PidsLimit: 32,
      ShmSize: 512 * 1048576,
      CapDrop: ["ALL"],
      SecurityOpt: [
        "no-new-privileges",
        "apparmor=fixture-profile",
        `seccomp=/etc/lyrashield/control/seccomp/${bytesHash(seccomp)}.json`,
      ],
    },
    NetworkSettings: { Networks: networks },
    AppArmorProfile: "fixture-profile",
    Mounts: installed.mounts.map((mount) => ({
      Type: "bind",
      Source: mount.source,
      Destination: mount.target,
      RW: false,
    })),
  }
  if (kind === "user") actual.Config.User = "0:0"
  if (kind === "mount") actual.Mounts[0]!.RW = true
  if (kind === "network") actual.HostConfig.NetworkMode = "host"
  if (kind === "capabilities") actual.HostConfig.CapDrop = []
  if (kind === "image") actual.Config.Image = "foreign-image"
  if (kind === "privileged") actual.HostConfig.Privileged = true
  if (kind === "extra-network") actual.NetworkSettings.Networks.bridge = {}
  if (kind === "tmpfs") actual.HostConfig.Tmpfs["/tmp"] = "rw,exec"
  io.exec.mockResolvedValue({ stdout: JSON.stringify([actual]) })
  if (kind === "valid") await verifyProtectedContainer(ownership, spec, installed)
  else
    await expect(verifyProtectedContainer(ownership, spec, installed)).rejects.toThrow(
      /approved resources/
    )
})
