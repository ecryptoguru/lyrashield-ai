import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  classifyColdContainers,
  executeColdBarrier,
} from "../../../ops/worker/cold-start-barrier.mjs"
const options = {
  workerImage: `ghcr.io/ecryptoguru/lyrashield-worker@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"b".repeat(64)}`,
  network: "lyrashield-sandbox",
}
const sandbox = () => ({
  Id: "c".repeat(64),
  Image: `sha256:${"b".repeat(64)}`,
  Name: "/old-sandbox",
  Config: { Image: options.sandboxImage, Labels: { "strix-run-id": "c1234567890123456789012345" } },
  HostConfig: { NetworkMode: options.network, RestartPolicy: { Name: "no" } },
  Mounts: [{ Type: "bind", Source: "/var/lib/lyrashield/worker/tmp/strix_repos/old" }],
  State: { Running: true, Pid: 20 },
})
function fixture({ fail = "", delayed = false } = {}) {
  let resources = delayed ? [] : [sandbox()]
  const calls = []
  const command = (program, args) => {
    const call = `${program} ${args.join(" ")}`
    calls.push(call)
    if (fail && call.includes(fail)) throw new Error("lost native acknowledgement")
    if (program === "docker" && args[0] === "image")
      return `sha256:${args[2] === options.workerImage ? "a".repeat(64) : "b".repeat(64)}`
    if (args[0] === "show") return args.includes("--property=MainPID") ? "0\n" : "inactive\n"
    if (program === "docker" && args[1] === "ls") return resources.map((r) => r.Id).join("\n")
    if (program === "docker" && args[1] === "inspect") return JSON.stringify(resources)
    if (program === "docker" && args[1] === "rm")
      resources = resources.filter((r) => r.Id !== args.at(-1))
    if (call === "systemctl start docker.service" && delayed) resources = [sandbox()]
    return ""
  }
  return { calls, command }
}
test("cold restart terminates only authenticated old native sandbox after daemon barrier", () => {
  const f = fixture()
  assert.deepEqual(executeColdBarrier(options, f.command), {
    oldResources: 1,
    removedResources: 1,
    removedIds: ["c".repeat(64)],
  })
  assert.ok(
    f.calls.indexOf("systemctl stop docker.socket docker.service") <
      f.calls.findIndex((c) => c.startsWith("docker container rm"))
  )
  assert.ok(f.calls.includes(`docker container rm --force ${"c".repeat(64)}`))
})
test("an accepted delayed create is authenticated and terminated after daemon restart", () => {
  const f = fixture({ delayed: true })
  assert.deepEqual(executeColdBarrier(options, f.command), {
    oldResources: 0,
    removedResources: 1,
    removedIds: ["c".repeat(64)],
  })
})
for (const fail of [
  "systemctl stop lyrashield-worker",
  "flock --nonblock",
  "systemctl stop docker.socket",
  "systemctl start docker.service",
  "docker container rm",
]) {
  test(`lost acknowledgement at ${fail} fails closed`, () => {
    const f = fixture({ fail })
    assert.throws(() => executeColdBarrier(options, f.command), /lost native acknowledgement/)
  })
}
test("foreign images, labels, network, bind mounts and restart policies are rejected", () => {
  for (const mutate of [
    (r) => {
      r.Config.Image = "foreign"
    },
    (r) => {
      r.Config.Labels["strix-run-id"] = "../foreign"
    },
    (r) => {
      r.HostConfig.NetworkMode = "bridge"
    },
    (r) => {
      r.Mounts[0].Source = "/foreign"
    },
    (r) => {
      r.HostConfig.RestartPolicy.Name = "always"
    },
  ]) {
    const r = sandbox()
    mutate(r)
    assert.throws(() => classifyColdContainers([r], options), /unresolved|unauthenticated/)
  }
})
test("launcher checks persistent fence before any consumer or registry operation", () => {
  const source = readFileSync("ops/worker/run-worker.sh", "utf8")
  assert.ok(
    source.indexOf('"$cold_start_directory/pending"') < source.indexOf("login_to_registry()")
  )
  assert.match(source, /flock -n 9/)
  assert.ok(
    source.indexOf(': > "$cold_start_directory/owner-started"') < source.indexOf("docker create \\")
  )
  assert.match(source, /\[ -e "\$cold_start_directory\/owner-started" \]/)
  assert.doesNotMatch(source, /docker rm -f lyrashield-worker.*true/)
  const worker = readFileSync("apps/worker/src/index.ts", "utf8")
  assert.ok(
    worker.indexOf("await assertNoNativeScanResources()") < worker.indexOf("worker = new Worker")
  )
})
