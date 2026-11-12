#!/usr/bin/env node
// Explicit, exclusive cold-host maintenance. This never changes durable scan state.
import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  constants,
} from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = "/var/lib/lyrashield/worker-cold-start"
const pending = `${directory}/pending`
const service = "lyrashield-worker.service"
const pin = /^ghcr\.io\/ecryptoguru\/lyrashield-(?:worker|sandbox)@sha256:[a-f0-9]{64}$/
const runId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function classifyColdContainers(
  records,
  { workerImage, sandboxImage, network, workerImageId, sandboxImageId }
) {
  return records.map((record) => {
    if (!/^[a-f0-9]{64}$/.test(record.Id ?? ""))
      throw new Error("Invalid native container identity")
    const restart = record.HostConfig?.RestartPolicy?.Name
    if (restart && restart !== "no")
      throw new Error("Native automatic restart ownership is unresolved")
    if (record.Name === "/lyrashield-worker") {
      const labels = record.Config?.Labels ?? {}
      if (
        record.Config.Image !== workerImage ||
        (workerImageId && record.Image !== workerImageId) ||
        !/^[a-f0-9]{40}$/.test(labels["org.opencontainers.image.revision"] ?? "") ||
        !/^[a-f0-9]{40}$/.test(labels["io.lyrashield.engine.revision"] ?? "")
      ) {
        throw new Error("Old worker identity mismatch")
      }
      return { id: record.Id, owner: true }
    }
    const scan = record.Config?.Labels?.["strix-run-id"]
    const mounts = record.Mounts ?? []
    if (
      record.Config?.Image !== sandboxImage ||
      (sandboxImageId && record.Image !== sandboxImageId) ||
      !runId.test(scan ?? "") ||
      scan.includes("..") ||
      record.HostConfig?.NetworkMode !== network ||
      !mounts.some((mount) => mount.Type === "bind") ||
      mounts.some(
        (mount) =>
          mount.Type === "bind" &&
          (!mount.Source?.startsWith("/var/lib/lyrashield/worker/") ||
            resolve(mount.Source) !== mount.Source)
      )
    ) {
      throw new Error("Foreign or unauthenticated container on cold host")
    }
    return { id: record.Id, owner: false }
  })
}

export function executeColdBarrier(options, command) {
  options = {
    ...options,
    workerImageId: command("docker", [
      "image",
      "inspect",
      options.workerImage,
      "--format",
      "{{.Id}}",
    ]).trim(),
    sandboxImageId: command("docker", [
      "image",
      "inspect",
      options.sandboxImage,
      "--format",
      "{{.Id}}",
    ]).trim(),
  }
  if (
    ![options.workerImageId, options.sandboxImageId].every((id) => /^sha256:[a-f0-9]{64}$/.test(id))
  ) {
    throw new Error("Pinned old native image identity is unavailable")
  }
  const inventory = () => {
    const ids = command("docker", ["container", "ls", "--all", "--quiet", "--no-trunc"])
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    return ids.length ? JSON.parse(command("docker", ["container", "inspect", ...ids])) : []
  }
  const old = classifyColdContainers(inventory(), options)
  // Stop acknowledgement is required; a failed/lost acknowledgement holds the fence.
  command("systemctl", ["stop", service])
  if (
    command("systemctl", ["show", service, "--property=ActiveState", "--value"]).trim() !==
      "inactive" ||
    command("systemctl", ["show", service, "--property=MainPID", "--value"]).trim() !== "0"
  ) {
    throw new Error("Previous systemd owner did not terminate")
  }
  command("flock", ["--nonblock", `${directory}/owner.lock`, "true"])
  // A missing container snapshot alone cannot drain accepted daemon operations.
  // Stop both socket activation and daemon, then verify the old daemon is gone.
  command("systemctl", ["stop", "docker.socket", "docker.service"])
  for (const unit of ["docker.socket", "docker.service"]) {
    if (
      command("systemctl", ["show", unit, "--property=ActiveState", "--value"]).trim() !==
        "inactive" ||
      command("systemctl", ["show", unit, "--property=MainPID", "--value"]).trim() !== "0"
    ) {
      throw new Error("Native Docker owner did not terminate")
    }
  }
  command("systemctl", ["start", "docker.service"])
  const after = classifyColdContainers(inventory(), options)
  // Accepted create calls may have committed after the first inventory. Once
  // the old owner and daemon are gone, authenticate those exact IDs as well.
  for (const resource of after) {
    const record = inventory().find((entry) => entry.Id === resource.id)
    if (!record) throw new Error("Native cleanup identity changed")
    if (resource.owner && (record.State?.Running || record.State?.Pid)) {
      throw new Error("Previous native worker survived cold barrier")
    }
    command("docker", ["container", "rm", "--force", resource.id])
  }
  if (inventory().length) throw new Error("Native cleanup acknowledgement is incomplete")
  return {
    oldResources: old.length,
    removedResources: after.length,
    removedIds: after.map((resource) => resource.id),
  }
}

function main() {
  if (process.getuid?.() !== 0) throw new Error("Cold barrier requires root on the exclusive host")
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (process.env[name]) throw new Error("Remote Docker configuration is forbidden")
  }
  const args = process.argv.slice(2)
  const option = (name) => args[args.indexOf(name) + 1]
  const options = {
    workerImage: option("--worker-image"),
    sandboxImage: option("--sandbox-image"),
    network: option("--network"),
  }
  if (
    option("--confirm") !== "COLD_SINGLE_WORKER" ||
    !pin.test(options.workerImage ?? "") ||
    !options.workerImage.includes("/lyrashield-worker@") ||
    !pin.test(options.sandboxImage ?? "") ||
    !options.sandboxImage.includes("/lyrashield-sandbox@") ||
    options.network !== "lyrashield-sandbox"
  ) {
    throw new Error(
      "Exact old worker/sandbox pins and cold single-worker confirmation are required"
    )
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const state = lstatSync(directory)
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== 0 ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error("Cold barrier state directory ownership is invalid")
  }
  // Separate operator mutex covers stop, daemon barrier and cleanup; launcher
  // is blocked by pending throughout. Failure deliberately retains pending.
  if (!args.includes("--operator-locked")) {
    const result = spawnSync(
      "flock",
      [
        "--nonblock",
        `${directory}/operator.lock`,
        process.execPath,
        fileURLToPath(import.meta.url),
        ...args,
        "--operator-locked",
      ],
      { stdio: "inherit" }
    )
    if (result.error || result.status !== 0)
      throw new Error("Cold host barrier failed; fence remains held")
    return
  }
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600
  )
  closeSync(fd)
  const command = (program, arguments_) =>
    execFileSync(program, arguments_, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
  const result = executeColdBarrier(options, command)
  const receipt = {
    ...options,
    ...result,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    finishedAt: new Date().toISOString(),
  }
  const receiptTemporary = `${directory}/receipt-${process.pid}.json`
  writeFileSync(receiptTemporary, JSON.stringify(receipt), { flag: "wx", mode: 0o600 })
  renameSync(receiptTemporary, `${directory}/receipt.json`)
  try {
    unlinkSync(`${directory}/owner-started`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  unlinkSync(pending)
  console.log(JSON.stringify(receipt))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
