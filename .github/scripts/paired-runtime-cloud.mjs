import { createRequire } from "node:module"
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { observeRuntimeDatabase } from "./v26-runtime-database.mjs"
// Real, fixed Azure operations. Never invoke the ordinary three-service
// promotion helper: its rollback changes multiple routes inside one call.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const repo = "ghcr.io/ecryptoguru/lyrashield-ai/"
const roles = {
  app: ["APP_NAME", "lyrashield-web"],
  scanner: ["SCANNER_NAME", "lyrashield-web"],
  relay: ["EGRESS_NAME", "lyrashield-egress-proxy"],
}
const nameRx = /^[a-z][a-z0-9-]{0,30}$/,
  sha = /^[a-f0-9]{40}$/,
  digest = /^sha256:[a-f0-9]{64}$/
function ok(c) {
  if (!c) throw new Error("Paired Azure readback mismatch")
}
function runCommand(file, args, timeout = 60000) {
  try {
    return execFileSync(file, args, {
      cwd: root,
      encoding: "utf8",
      timeout,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GH_HOST: "github.com",
        GH_PROMPT_DISABLED: "1",
      },
      maxBuffer: 2097152,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (e) {
    const err = new Error("Paired infrastructure operation unconfirmed")
    // Only the allowlisted diagnostics emitted by our VM wrapper may be retained.
    if (
      file === "bash" &&
      (args[0] === ".github/scripts/paired-runtime-vm.sh" ||
        args[0].endsWith("/.github/scripts/paired-runtime-vm.sh")) &&
      Buffer.byteLength(e.stderr ?? "") <= 2048
    )
      err.stderr = e.stderr
    throw err
  }
}
function az(args) {
  let raw = runCommand("az", [...args, "--only-show-errors", "--output", "json"])
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error("Invalid Azure readback")
  }
}
function target(role, pair) {
  ok(Object.hasOwn(roles, role))
  const [env, image] = roles[role],
    name = process.env[env],
    group = process.env.RG
  ok(
    typeof name === "string" &&
      nameRx.test(name) &&
      typeof group === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,89}$/.test(group)
  )
  const candidate = pair[role]?.candidate,
    previous = pair[role]?.previous
  for (const rev of [candidate, previous])
    ok(
      typeof rev === "string" &&
        rev.startsWith(name + "--") &&
        /^[a-z][a-z0-9-]{0,30}--[a-z0-9][a-z0-9-]{0,30}$/.test(rev)
    )
  const d = role === "relay" ? pair.proxyDigest : pair.webDigest
  ok(digest.test(d) && previous !== candidate)
  return {
    name,
    group,
    candidate,
    previous,
    image: repo + image + "@" + d,
    args: ["--name", name, "--resource-group", group],
  }
}
function revisions(t) {
  const list = az(["containerapp", "revision", "list", ...t.args, "--all"])
  ok(
    Array.isArray(list) &&
      list.length <= 100 &&
      new Set(list.map((r) => r.name)).size === list.length
  )
  return list
}
function traffic(t) {
  const list = az(["containerapp", "ingress", "traffic", "show", ...t.args])
  ok(
    Array.isArray(list) &&
      list.length > 0 &&
      list.length <= 100 &&
      list.every(
        (r) =>
          r.latestRevision !== true &&
          !r.label &&
          Number.isInteger(r.weight) &&
          r.weight >= 0 &&
          r.weight <= 100
      )
  )
  const active = list.filter((r) => r.weight > 0)
  ok(active.length === 1 && active[0].weight === 100 && typeof active[0].revisionName === "string")
  return active[0].revisionName
}
function replicas(t, revision) {
  const list = az(["containerapp", "replica", "list", ...t.args, "--revision", revision])
  ok(
    Array.isArray(list) &&
      list.length <= 100 &&
      new Set(list.map((r) => r.name)).size === list.length
  )
  return list
}
function verifyImage(r, expected) {
  ok(
    r?.properties?.template?.containers?.length === 1 &&
      r.properties.template.containers[0].image === expected
  )
}
export async function azureServingRoute(role, pair) {
  const t = target(role, pair),
    list = revisions(t),
    r = list.find((row) => row.name === t.candidate),
    old = list.find((row) => row.name === t.previous)
  verifyImage(r, t.image)
  ok(old && r.properties.active === true)
  if (role === "relay")
    ok(
      r.properties?.template?.scale?.minReplicas === 1 &&
        r.properties.template.scale.maxReplicas === 1
    )
  let oldReachable = old.properties.active !== false
  if (!oldReachable) {
    const host = old.properties?.fqdn
    ok(
      typeof host === "string" &&
        host.startsWith(t.previous + ".") &&
        /^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(host)
    )
    const denied = await fetch("https://" + host + (role === "relay" ? "/health" : "/api/ready"), {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    })
    oldReachable = ![404, 410].includes(denied.status)
    await denied.body?.cancel()
  }
  const serving = traffic(t),
    instances = replicas(t, t.candidate),
    oldInstances = replicas(t, t.previous)
  return {
    revision: r.name,
    digest: t.image.split("@")[1],
    traffic: [{ revision: serving, weight: 100 }],
    oldRevisionReachable: oldReachable,
    oldServingReplicas: oldInstances.length,
    otherServingRevisions: list.filter(
      (row) => row.name !== r.name && row.properties?.active !== false
    ).length,
    healthy:
      r.properties.healthState === "Healthy" &&
      r.properties.runningState === "Running" &&
      instances.length > 0 &&
      instances.every(
        (i) => i.properties?.containers?.length === 1 && i.properties.containers[0].ready === true
      ),
    replicas: instances.length,
  }
}
export function verifyZeroTrafficCandidate(role, pair) {
  const t = target(role, pair)
  ok(traffic(t) === t.previous)
  const r = az(["containerapp", "revision", "show", ...t.args, "--revision", t.candidate])
  verifyImage(r, t.image)
  ok(
    r.name === t.candidate && r.properties.active === true && r.properties.healthState === "Healthy"
  )
}
export function stageAtZeroTraffic(role, pair) {
  const t = target(role, pair)
  ok(sha.test(pair.productRevision) && traffic(t) === t.previous)
  const app = az(["containerapp", "show", ...t.args])
  ok(app.properties?.configuration?.activeRevisionsMode === "Multiple")
  const list = revisions(t)
  ok(
    list.some((r) => r.name === t.previous && r.properties.active === true) &&
      !list.some((r) => r.name === t.candidate)
  )
  // Explicit named prior traffic remains 100%, including across command failure.
  const args = [
    "containerapp",
    "revision",
    "copy",
    ...t.args,
    "--from-revision",
    t.previous,
    "--revision-suffix",
    t.candidate.slice(t.name.length + 2),
    "--image",
    t.image,
  ]
  if (role === "relay") args.push("--min-replicas", "1", "--max-replicas", "1")
  if (role !== "relay")
    args.push("--set-env-vars", "LYRASHIELD_PRODUCT_REVISION=" + pair.productRevision)
  az(args)
  verifyZeroTrafficCandidate(role, pair)
}
export function reactivateArchivedRevision(role, pair) {
  const t = target(role, pair)
  ok(traffic(t) === t.previous)
  const r = az(["containerapp", "revision", "show", ...t.args, "--revision", t.candidate])
  verifyImage(r, t.image)
  ok(r.name === t.candidate)
  az(["containerapp", "revision", "activate", ...t.args, "--revision", t.candidate])
  verifyZeroTrafficCandidate(role, pair)
}
export function promoteNamedRoute(role, pair) {
  const t = target(role, pair)
  verifyZeroTrafficCandidate(role, pair)
  runCommand("bash", [
    ".github/scripts/paired-runtime-route.sh",
    role,
    t.group,
    t.name,
    t.candidate,
    t.image.split("@")[1],
  ])
}
export function retirePreviousRevision(role, pair) {
  const t = target(role, pair)
  ok(traffic(t) === t.candidate)
  verifyImage(
    az(["containerapp", "revision", "show", ...t.args, "--revision", t.candidate]),
    t.image
  )
  az(["containerapp", "revision", "deactivate", ...t.args, "--revision", t.previous])
  const old = az(["containerapp", "revision", "show", ...t.args, "--revision", t.previous])
  ok(
    old.name === t.previous &&
      old.properties?.active === false &&
      replicas(t, t.previous).length === 0 &&
      traffic(t) === t.candidate
  )
}
export function promoteStoppedWorker(p) {
  // Recovery executes from trusted current source; the existing wrapper refuses
  // a different checked-out SHA. An archived A payload must come from A's Git blobs.
  const args = [
    p.owner,
    p.productRevision,
    p.engineRevision,
    p.workerDigest,
    p.priorWorkerDigest,
    process.env.RG,
    process.env.WORKER_VM_NAME,
    process.env.AZURE_APP_SECRET_KEY_VAULT_NAME,
    p.sandboxDigest,
  ]
  ok(sha.test(p.productRevision))
  const head = runCommand("git", ["--no-replace-objects", "rev-parse", "HEAD"])
  if (head === p.productRevision) {
    runCommand("bash", [".github/scripts/paired-runtime-vm.sh", ...args], 1810000)
    return
  }
  // Historical rollback needs actual archived Git contents. Never checkout over
  // the trusted current-main controller or copy a candidate source overlay.
  const compare = JSON.parse(
    runCommand("gh", [
      "api",
      "--hostname",
      "github.com",
      "repos/ecryptoguru/lyrashield-ai/compare/" + p.productRevision + "..." + head + "?per_page=1",
    ])
  )
  ok(compare.merge_base_commit?.sha === p.productRevision && compare.status === "ahead")
  const dir = mkdtempSync(join(tmpdir(), "paired-historical-"))
  try {
    runCommand("git", ["init", "--quiet", dir])
    runCommand("git", [
      "-C",
      dir,
      "-c",
      "credential.https://github.com.helper=",
      "-c",
      "credential.https://github.com.helper=!gh auth git-credential",
      "fetch",
      "--no-tags",
      "--depth=1",
      "https://github.com/ecryptoguru/lyrashield-ai.git",
      p.productRevision,
    ])
    runCommand("git", [
      "-C",
      dir,
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "checkout",
      "--quiet",
      "--detach",
      "FETCH_HEAD",
    ])
    ok(
      runCommand("git", ["-C", dir, "--no-replace-objects", "rev-parse", "HEAD"]) ===
        p.productRevision
    )
    runCommand("bash", [join(dir, ".github/scripts/paired-runtime-vm.sh"), ...args], 1810000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
export async function readReadiness() {
  const host = "https://app.lyrashieldai.com"
  const get = async (path) => {
    const res = await fetch(host + path, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    })
    ok(res.body)
    let bytes = 0
    const chunks = []
    for await (const c of res.body) {
      bytes += c.length
      ok(bytes <= 4096)
      chunks.push(c)
    }
    return { code: String(res.status), body: Buffer.concat(chunks).toString("utf8") }
  }
  const [api, scans] = await Promise.all([get("/api/ready"), get("/api/ready/scans")])
  return { readyCode: api.code, readyBody: api.body, scansCode: scans.code, scansBody: scans.body }
}

export function relayHost(pair) {
  const t = target("relay", pair),
    ref = az(["containerapp", "show", ...t.args])
  const host = ref.properties?.configuration?.ingress?.fqdn
  ok(typeof host === "string" && /^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(host))
  return host
}
export async function compareProducerConnections(pair, worker) {
  // Same read-only ACA secret resolution and physical DB observation as the
  // reviewed v26 observer. A changed URL cannot silently point at another DB.
  const { Client } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg")
  for (const role of ["app", "scanner"]) {
    const t = target(role, pair),
      live = traffic(t),
      r = az(["containerapp", "revision", "show", ...t.args, "--revision", live])
    const env = r.properties?.template?.containers?.[0]?.env,
      secrets = az(["containerapp", "secret", "list", ...t.args, "--show-values"])
    const get = (k) => {
      const rows = env.filter((v) => v.name === k)
      ok(rows.length === 1 && rows[0].secretRef)
      const match = secrets.filter((v) => v.name === rows[0].secretRef)
      ok(match.length === 1 && typeof match[0].value === "string" && match[0].value.length)
      return match[0].value
    }
    const verifyReplicas = () =>
      replicas(t, live)
        .map((item) => item.name)
        .sort()
    const before = verifyReplicas(),
      container = r.properties.template.containers[0].name
    ok(before.length >= 1 && before.length <= 8 && /^[a-z][a-z0-9-]{0,62}$/.test(container))
    const expected = ["DATABASE_URL", "REDIS_URL"]
      .map((k) => createHash("sha256").update(get(k)).digest("hex"))
      .join(" ")
    for (const replica of before) {
      ok(typeof replica === "string" && /^[a-z0-9-]{1,128}$/.test(replica))
      const actual = runCommand(
        "python3",
        [
          "-I",
          ".github/scripts/paired-live-replica.py",
          t.group,
          t.name,
          live,
          replica,
          container,
          randomBytes(32).toString("hex"),
        ],
        45000
      )
      ok(actual === expected)
    }
    ok(JSON.stringify(before) === JSON.stringify(verifyReplicas()) && traffic(t) === live)
    ok(createHash("sha256").update(get("REDIS_URL")).digest("hex") === worker.redisUrlHash)
    const conn = new Client({
      connectionString: get("DATABASE_URL"),
      connectionTimeoutMillis: 5000,
      statement_timeout: 6000,
    })
    try {
      await conn.connect()
      ok((await observeRuntimeDatabase(conn)).databaseIdentity === worker.databaseIdentity)
    } catch {
      throw new Error("Producer database continuity unavailable")
    } finally {
      await conn.end().catch(() => {})
    }
  }
}
export function verifyImageSources(pair) {
  const refs = [
    ["web", repo + "lyrashield-web", pair.webDigest, pair.productRevision],
    ["relay", repo + "lyrashield-egress-proxy", pair.proxyDigest, pair.productRevision],
    ["worker", repo + "lyrashield-worker", pair.workerDigest, pair.productRevision],
    ["sandbox", "ghcr.io/ecryptoguru/lyrashield-sandbox", pair.sandboxDigest, pair.engineRevision],
  ]
  for (const [kind, name, d, rev] of refs) {
    ok(digest.test(d) && sha.test(rev))
    if (kind === "sandbox") {
      const index = JSON.parse(
        runCommand("docker", ["buildx", "imagetools", "inspect", name + "@" + d, "--raw"])
      )
      const platforms = index.manifests
        ?.filter((m) => m.platform?.os === "linux")
        .map((m) => m.platform.architecture)
        .sort()
      ok(JSON.stringify(platforms) === JSON.stringify(["amd64", "arm64"]))
    }
    const raw = JSON.parse(
      runCommand("docker", [
        "buildx",
        "imagetools",
        "inspect",
        name + "@" + d,
        "--format",
        "{{json .Image}}",
      ])
    )
    const configs = raw?.config ? [raw] : Object.values(raw || {})
    ok(
      configs.length &&
        configs.every((v) => {
          const labels = v?.config?.Labels
          return (
            labels?.["org.opencontainers.image.revision"] === rev &&
            (kind !== "worker" || labels["io.lyrashield.engine.revision"] === pair.engineRevision)
          )
        })
    )
  }
}

export function verifyCompatibleMaintenance() {
  // Re-probe the existing read-only classifiers. The v26 prepare command can
  // mutate state, so it is never called here.
  const dir = mkdtempSync(join(tmpdir(), "paired-classifiers-")),
    out = join(dir, "result")
  try {
    runCommand("bash", [".github/scripts/assert-no-held-v26.sh"])
    runCommand(
      process.execPath,
      [".github/scripts/verify-webhook-cutover.mjs", "--expect-mode", "compatible"],
      180000
    )
    execFileSync(process.execPath, [".github/scripts/v26-schema-classifier.mjs"], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: out },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 40000,
      maxBuffer: 4096,
    })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private classifier output in a fresh temporary directory
    ok(readFileSync(out, "utf8").trim() === "v26_schema=current")
  } catch {
    throw new Error("Compatible maintenance state unverified")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
