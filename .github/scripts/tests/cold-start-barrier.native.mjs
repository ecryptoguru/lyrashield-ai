// Opt-in native Docker lifecycle proof in an isolated Docker-in-Docker daemon.
// This exercises real daemon stop/start and removal acknowledgements. The
// systemd adapter is test-only; production systemd unit acceptance is separate.
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { executeColdBarrier } from "../../../ops/worker/cold-start-barrier.mjs"

if (process.env.LYRASHIELD_RUN_ISOLATED_NATIVE_COLD_PROOF !== "1") {
  throw new Error("Set LYRASHIELD_RUN_ISOLATED_NATIVE_COLD_PROOF=1 for the isolated native proof")
}
const host = `lyrashield-cold-proof-${randomUUID()}`
const image =
  "docker.io/library/docker@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121"
const run = (args, input) =>
  execFileSync("docker", args, { input, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 })
const inside = (args) => run(["exec", host, ...args])
const pause = () => new Promise((resolve) => setTimeout(resolve, 100))
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      inside(["docker", "info"])
      return
    } catch {
      await pause()
    }
  }
  throw new Error("Isolated native Docker daemon did not become ready")
}
try {
  run([
    "run",
    "--detach",
    "--name",
    host,
    "--privileged",
    "--network=none",
    "--env",
    "DOCKER_TLS_CERTDIR=",
    "--entrypoint",
    "sh",
    image,
    "-c",
    "dockerd --host=unix:///var/run/docker.sock --pidfile=/run/cold-dockerd.pid >/tmp/dockerd.log 2>&1 & exec tail -f /dev/null",
  ])
  await ready()
  // Only this invocation's nested daemon receives the image; no host resources
  // are passed into nested sandboxes and no external registry traffic is used.
  const save = spawn("docker", ["image", "save", "docker:29-dind"], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  const load = spawn("docker", ["exec", "--interactive", host, "docker", "image", "load"], {
    stdio: ["pipe", "ignore", "inherit"],
  })
  save.stdout.pipe(load.stdin)
  await Promise.all(
    [save, load].map(
      (child) =>
        new Promise((resolve, reject) =>
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Native fixture image transfer failed"))
          )
        )
    )
  )
  // docker save/load may retain tag rather than RepoDigest; pin by actual local
  // content ID for this fixture. Production CLI requires repository digests.
  const contentId = inside(["docker", "image", "ls", "--all", "--quiet", "--no-trunc"])
    .trim()
    .split("\n")[0]
  inside(["mkdir", "-p", "/var/lib/lyrashield/worker/tmp/strix_repos/old"])
  inside([
    "docker",
    "network",
    "create",
    "--internal",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    "lyrashield-sandbox",
  ])
  const create = () =>
    inside([
      "docker",
      "run",
      "--detach",
      "--network=lyrashield-sandbox",
      "--label",
      "strix-run-id=c1234567890123456789012345",
      "--mount",
      "type=bind,src=/var/lib/lyrashield/worker/tmp/strix_repos/old,dst=/work",
      "--entrypoint",
      "tail",
      contentId,
      "-f",
      "/dev/null",
    ]).trim()
  inside([
    "docker",
    "run",
    "--detach",
    "--name",
    "lyrashield-worker",
    "--network=none",
    "--label",
    `org.opencontainers.image.revision=${"a".repeat(40)}`,
    "--label",
    `io.lyrashield.engine.revision=${"b".repeat(40)}`,
    "--entrypoint",
    "tail",
    contentId,
    "-f",
    "/dev/null",
  ])
  const id = create()
  const options = { workerImage: contentId, sandboxImage: contentId, network: "lyrashield-sandbox" }
  let stopped = false
  const command = (program, args) => {
    if (program === "docker") return inside([program, ...args])
    if (program === "flock") return "" // no worker in the isolated fixture
    if (
      program === "systemctl" &&
      args[0] === "stop" &&
      args.includes("lyrashield-worker.service")
    ) {
      if (
        inside([
          "docker",
          "container",
          "ls",
          "--all",
          "--quiet",
          "--filter",
          "name=^/lyrashield-worker$",
        ]).trim()
      ) {
        inside(["docker", "stop", "--time=1", "lyrashield-worker"])
        inside(["docker", "rm", "lyrashield-worker"])
      }
      return ""
    }
    if (args[0] === "show") return args.includes("--property=MainPID") ? "0" : "inactive"
    if (args[0] === "stop" && args.includes("docker.service")) {
      inside([
        "sh",
        "-c",
        'pid=$(cat /run/cold-dockerd.pid); kill -TERM "$pid"; for n in $(seq 1 100); do if ! kill -0 "$pid" 2>/dev/null || [ "$(cut -d \" \" -f 3 /proc/$pid/stat 2>/dev/null)" = Z ]; then exit 0; fi; sleep 0.1; done; exit 1',
      ])
      stopped = true
      return ""
    }
    if (args[0] === "start") {
      assert.ok(stopped)
      return inside([
        "sh",
        "-c",
        "dockerd --host=unix:///var/run/docker.sock --pidfile=/run/cold-dockerd.pid >/tmp/dockerd.log 2>&1 & for n in $(seq 1 100); do docker info >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1",
      ])
    }
    return ""
  }
  const receipt = executeColdBarrier(options, command)
  assert.deepEqual(receipt.removedIds, [id])
  assert.equal(inside(["docker", "container", "ls", "--all", "--quiet"]).trim(), "")
  // Lost removal acknowledgement must reject even when the daemon committed it.
  const lostId = create()
  assert.throws(
    () =>
      executeColdBarrier(options, (program, args) => {
        const result = command(program, args)
        if (program === "docker" && args[1] === "rm") throw new Error("lost remove acknowledgement")
        return result
      }),
    /lost remove acknowledgement/
  )
  assert.equal(inside(["docker", "container", "ls", "--all", "--quiet"]).trim(), "")
  console.log(
    JSON.stringify({
      nativeDaemonCycle: "PASS",
      exactSandboxRemoved: id,
      lostAcknowledgementRejected: lostId,
      systemdQualification: "NOT_TESTED",
    })
  )
} finally {
  run(["rm", "--force", host])
}
