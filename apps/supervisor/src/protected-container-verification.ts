import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ExecutorSpec, ResourceOwnership } from "@lyrashield/runtime-control"
import type { loadProtectedResourceInstallation } from "./protected-resource-installation"

const execFileAsync = promisify(execFile)
type InstalledResources = Awaited<ReturnType<typeof loadProtectedResourceInstallation>>

export async function verifyProtectedContainer(
  ownership: ResourceOwnership,
  spec: Extract<ExecutorSpec, { kind: "container" }>,
  installation: InstalledResources
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(ownership.containerId ?? "") || !spec.resourceDescriptor)
    throw new Error("Protected container identity is unavailable")
  const result = await execFileAsync(
    "docker",
    ["inspect", "--type", "container", ownership.containerId!],
    { timeout: 20_000, maxBuffer: 262_144 }
  )
  const records: unknown = JSON.parse(result.stdout)
  if (!Array.isArray(records) || records.length !== 1)
    throw new Error("Protected container inspection is unavailable")
  const actual = records[0]
  const descriptor = spec.resourceDescriptor
  const host = actual?.HostConfig
  const config = actual?.Config
  const security = host?.SecurityOpt
  if (
    actual?.Id !== ownership.containerId ||
    config?.Image !== spec.image ||
    config?.User !== `${descriptor.uid}:${descriptor.gid}` ||
    config?.WorkingDir !== descriptor.workdir ||
    config?.Labels?.["lyrashield.supervisor.ownership"] !== ownership.ownershipId ||
    config?.Labels?.["lyrashield.supervisor.descriptor"] !== installation.descriptorChecksum ||
    host?.NetworkMode !== spec.network ||
    host?.ReadonlyRootfs !== true ||
    host?.Privileged !== false ||
    host?.Init !== true ||
    host?.PidMode !== "" ||
    host?.IpcMode !== "private" ||
    (host?.CapAdd !== null && (!Array.isArray(host?.CapAdd) || host.CapAdd.length !== 0)) ||
    !Array.isArray(host?.Devices) ||
    host.Devices.length !== 0 ||
    (host?.DeviceRequests !== null &&
      (!Array.isArray(host?.DeviceRequests) || host.DeviceRequests.length !== 0)) ||
    host?.PublishAllPorts !== false ||
    (host?.PortBindings !== null && Object.keys(host?.PortBindings ?? {}).length !== 0) ||
    Object.keys(actual?.NetworkSettings?.Networks ?? {}).length !== 1 ||
    !Object.hasOwn(actual.NetworkSettings.Networks, spec.network) ||
    host?.Tmpfs?.[descriptor.workspaceRoot] !==
      `rw,nosuid,nodev,uid=${descriptor.uid},gid=${descriptor.gid},mode=0750` ||
    host?.Tmpfs?.["/tmp"] !== "rw,noexec,nosuid,nodev,size=256m" ||
    host?.Memory !== spec.memoryMb * 1_048_576 ||
    host?.NanoCpus !== Math.round(spec.cpus * 1_000_000_000) ||
    host?.PidsLimit !== spec.pidsLimit ||
    host?.ShmSize !== descriptor.isolation.shmMb * 1_048_576 ||
    !Array.isArray(host?.CapDrop) ||
    host.CapDrop.length !== 1 ||
    host.CapDrop[0] !== "ALL" ||
    !Array.isArray(security) ||
    security.length !== 3 ||
    !security.includes("no-new-privileges") ||
    !security.includes(`apparmor=${descriptor.isolation.appArmorProfile}`) ||
    !security.includes(
      `seccomp=/etc/lyrashield/control/seccomp/${descriptor.isolation.seccompPolicyChecksum}.json`
    ) ||
    actual?.AppArmorProfile !== descriptor.isolation.appArmorProfile ||
    !Array.isArray(actual?.Mounts) ||
    actual.Mounts.length !== installation.mounts.length ||
    actual.Mounts.some(
      (mount: { Type?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown }) =>
        mount.Type !== "bind" ||
        mount.RW !== false ||
        !installation.mounts.some(
          (expected) => mount.Source === expected.source && mount.Destination === expected.target
        )
    )
  )
    throw new Error("Protected container configuration does not match approved resources")
}
