import { readPrivateRecord } from "./private-record.mjs"
import { qualifyReleaseSource } from "./qualify-release-source.mjs"
import { assertExpectedPublisherHold } from "./sandbox-publisher-hold.mjs"
import { protectedGh } from "./protected-gh.mjs"
// Trust the protected job and its immutable run attempt, not a caller's
// repository name, artifact filename, or self-reported GitHub environment.
import { createHash, createPublicKey, verify } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstatSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = "ecryptoguru/lyrashield-ai",
  ISSUER = "https://token.actions.githubusercontent.com"
const ENV = "azure-production",
  JOB = ".github/workflows/deploy-azure-runtime.yml"
const ISSUER_ENV = "release-qualification",
  ISSUER_JOB = ".github/workflows/issue-runtime-qualification.yml"
const qualificationKinds = new Set([
  "held-baseline",
  "promotion-action-lease",
  "qualified-fleet",
  "qualified-release",
  "sandbox-qualification",
  "financial-qualification",
  "reader-qualification",
  "runtime-fleet-qualification",
  "arm-approval",
  "rebind-approval",
  "handoff",
])
const ownerJobs = new Set([JOB, ".github/workflows/deploy-azure.yml"])
const ENTRIES = new Map([
  [".github/workflows/release-production.yml", "push"],
  [".github/workflows/deploy-azure.yml", "workflow_dispatch"],
  [".github/workflows/qualify-runtime-issuer.yml", "workflow_dispatch"],
])
const sha = /^[a-f0-9]{40}$/,
  hash = /^[a-f0-9]{64}$/,
  id = /^[1-9][0-9]{0,19}$/
const kinds = new Set([
  "held-baseline",
  "promotion-action-lease",
  "qualified-fleet",
  "hold-acquisition",
  "handoff",
  "restore",
  "arm",
  "qualified-release",
  "continuity",
  "evidence",
  "operation",
  "sandbox-qualification",
  "financial-qualification",
  "reader-qualification",
  "release-readback",
  "runtime-fleet-qualification",
  "arm-approval",
  "rebind-approval",
])
function check(ok) {
  if (!ok) throw new Error("Protected GitHub provenance unverified")
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function json(data) {
  try {
    return JSON.parse(data)
  } catch {
    throw new Error("Invalid protected response")
  }
}
function local(file, args, max = 1024 * 1024, input) {
  try {
    return execFileSync(file, args, {
      input,
      timeout: 30000,
      maxBuffer: max,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_DEBUG: "" },
    })
  } catch {
    throw new Error("Protected GitHub transport failed")
  }
}
function gh(path, zip = false) {
  const b = local(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      `repos/${REPO}${path ? "/" + path : ""}`,
    ],
    zip ? 65536 : 1024 * 1024
  )
  return zip ? b : json(b)
}
function numberId(n) {
  check(Number.isSafeInteger(n) && n > 0)
  return String(n)
}
function runIdentity(repo, run, source, owner, historical) {
  const [runId, attempt] = owner.split(":")
  check(
    repo.full_name === REPO &&
      repo.owner?.login === "ecryptoguru" &&
      numberId(repo.id) === numberId(run.repository?.id) &&
      numberId(repo.id) === numberId(run.head_repository?.id)
  )
  const path = run.path?.split("@")[0],
    event = ENTRIES.get(path)
  check(
    event &&
      run.event === event &&
      run.head_branch === "main" &&
      run.head_sha === source &&
      String(run.id) === runId &&
      String(run.run_attempt) === attempt
  )
  check(
    historical
      ? run.status === "completed" && run.conclusion === "success"
      : run.status === "in_progress" && run.conclusion === null
  )
  return {
    source,
    owner,
    runId,
    attempt,
    path,
    event,
    repoId: String(repo.id),
    ownerId: numberId(repo.owner.id),
  }
}
function audience(purpose, digest) {
  return `urn:lyrashield:paired:v1:${purpose}:${digest}`
}
async function getLimited(url, options, max) {
  let r
  try {
    r = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      cache: "no-store",
    })
    check(r.ok && r.body)
    const chunks = []
    let size = 0
    for await (const c of r.body) {
      size += c.length
      check(size <= max)
      chunks.push(c)
    }
    return json(Buffer.concat(chunks))
  } catch {
    throw new Error("Protected identity service unavailable")
  }
}
function claims(token, jwks, identity, aud, when, jobWorkflow = JOB, environment = ENV) {
  check(
    environment === ENV
      ? ownerJobs.has(jobWorkflow)
      : environment === ISSUER_ENV && jobWorkflow === ISSUER_JOB
  )
  check(typeof token === "string" && token.length <= 16384)
  const parts = token.split(".")
  check(parts.length === 3 && parts.every((x) => /^[\w-]+$/.test(x)))
  const header = json(Buffer.from(parts[0], "base64url")),
    c = json(Buffer.from(parts[1], "base64url"))
  check(
    header.alg === "RS256" &&
      typeof header.kid === "string" &&
      !header.crit &&
      Array.isArray(jwks.keys)
  )
  const keys = jwks.keys.filter(
    (k) =>
      k.kid === header.kid &&
      k.kty === "RSA" &&
      (!k.use || k.use === "sig") &&
      (!k.alg || k.alg === "RS256")
  )
  check(keys.length === 1)
  check(
    verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1]),
      createPublicKey({ key: keys[0], format: "jwk" }),
      Buffer.from(parts[2], "base64url")
    )
  )
  const x = identity,
    ref = "@refs/heads/main"
  check(
    c.iss === ISSUER &&
      c.aud === aud &&
      c.sub === `repo:${REPO}:environment:${environment}` &&
      c.environment === environment &&
      c.repository === REPO &&
      c.repository_id === x.repoId &&
      c.repository_owner_id === x.ownerId &&
      c.ref === "refs/heads/main" &&
      c.sha === x.source &&
      c.event_name === x.event &&
      c.run_id === x.runId &&
      c.run_attempt === x.attempt &&
      c.runner_environment === "github-hosted"
  )
  check(
    c.workflow_ref === `${REPO}/${x.path}${ref}` &&
      c.workflow_sha === x.source &&
      c.job_workflow_ref === `${REPO}/${jobWorkflow}${ref}` &&
      c.job_workflow_sha === x.source
  )
  check(
    [when, c.iat, c.exp, c.nbf].every(Number.isSafeInteger) &&
      c.exp > c.iat &&
      c.exp - c.iat <= 900 &&
      c.nbf <= when &&
      c.iat <= when &&
      when < c.exp
  )
}
export function verifyRecordWitness(token, jwks, identity, kind, digest, when, jobWorkflow = JOB) {
  check(kinds.has(kind) && hash.test(digest))
  const qualification =
    qualificationKinds.has(kind) || (kind === "evidence" && jobWorkflow === ISSUER_JOB)
  check(!qualification || jobWorkflow === ISSUER_JOB)
  claims(
    token,
    jwks,
    identity,
    audience(kind, digest),
    when,
    jobWorkflow,
    qualification ? ISSUER_ENV : ENV
  )
}

// The Azure credential is usable only inside the isolated reusable issuer.
// This token is never a qualification record or a deployment authorization.
export function verifyQualificationIssuerToken(token, jwks, identity, when) {
  check(identity.repoId === "1286618458" && identity.ownerId === "116722580")
  claims(token, jwks, identity, "api://AzureADTokenExchange", when, ISSUER_JOB, ISSUER_ENV)
}

export async function readQualificationIssuerToken() {
  const identity = currentRun()
  const token = await requestToken("api://AzureADTokenExchange")
  verifyQualificationIssuerToken(token, await keys(), identity, Math.floor(Date.now() / 1000))
  return { token, identity }
}
async function keys() {
  return getLimited(ISSUER + "/.well-known/jwks", {}, 65536)
}
async function requestToken(aud) {
  const u = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  check(
    u.protocol === "https:" &&
      u.hostname.endsWith(".actions.githubusercontent.com") &&
      !u.username &&
      !u.password &&
      !u.port
  )
  u.searchParams.set("audience", aud)
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  check(typeof bearer === "string" && bearer.length > 16)
  return (await getLimited(u, { headers: { Authorization: "Bearer " + bearer } }, 32768)).value
}
function currentRun() {
  const source = process.env.GITHUB_SHA,
    runId = process.env.GITHUB_RUN_ID,
    attempt = process.env.GITHUB_RUN_ATTEMPT
  check(
    sha.test(source) &&
      id.test(runId) &&
      id.test(attempt) &&
      process.env.GITHUB_REPOSITORY === REPO &&
      process.env.GITHUB_REF === "refs/heads/main"
  )
  const identity = runIdentity(
    gh(""),
    gh("actions/runs/" + runId),
    source,
    runId + ":" + attempt,
    false
  )
  check(
    gh("git/ref/heads/main").object?.sha === source &&
      local("git", ["--no-replace-objects", "rev-parse", "HEAD"], 256).toString().trim() === source
  )
  return identity
}
export async function readAuthenticatedOwner(jobWorkflow = JOB) {
  const issuer = jobWorkflow === ISSUER_JOB
  check(issuer || ownerJobs.has(jobWorkflow))
  const x = currentRun(),
    aud = audience("owner", x.owner)
  if (issuer) check(x.repoId === "1286618458" && x.ownerId === "116722580")
  claims(
    await requestToken(aud),
    await keys(),
    x,
    aud,
    Math.floor(Date.now() / 1000),
    jobWorkflow,
    issuer ? ISSUER_ENV : ENV
  )
  return x.owner
}
// Wire to the protected publishing step after qualifications. Keep the private
// canonical body outside the archive; commit only its content digest in the JWT.
export async function issueRecordWitness(kind, body, jobWorkflow = JOB) {
  check(
    kinds.has(kind) &&
      !["held-baseline", "promotion-action-lease"].includes(kind) &&
      (!qualificationKinds.has(kind) || jobWorkflow === ISSUER_JOB) &&
      typeof body === "string" &&
      Buffer.byteLength(body) <= 4096 &&
      json(body).kind === kind
  )
  const digest = sha256(body),
    x = currentRun(),
    token = await requestToken(audience(kind, digest))
  verifyRecordWitness(
    token,
    await keys(),
    x,
    kind,
    digest,
    Math.floor(Date.now() / 1000),
    jobWorkflow
  )
  return JSON.stringify({ version: 1, kind, digest, token })
}
function privateBytes(dir, name, max = 4096) {
  return readPrivateRecord(dir, name, max)
}
// Fixed private directory populated by the protected release transport. The
// locator is a hint only; GitHub, the OIDC signature and content hashes decide.
export function protectedSessionCookie() {
  const root = process.env.RUNNER_TEMP
  check(root?.startsWith("/"))
  const s = privateBytes(join(root, "lyrashield-paired-records"), "reader.cookie", 8192).trimEnd()
  check(s.length > 0 && !/[\r\n]/.test(s))
  return s
}
async function authenticateRecord(kind, digest, dir, jobWorkflow = JOB) {
  check(kinds.has(kind) && hash.test(digest))
  const loc = json(privateBytes(dir, digest + ".locator.json"))
  check(
    id.test(loc.runId) && id.test(loc.attempt) && id.test(loc.artifactId) && sha.test(loc.source)
  )
  const repo = gh(""),
    owner = loc.runId + ":" + loc.attempt
  const same =
    loc.runId === process.env.GITHUB_RUN_ID && loc.attempt === process.env.GITHUB_RUN_ATTEMPT
  const run = gh(`actions/runs/${loc.runId}/attempts/${loc.attempt}`),
    x = runIdentity(repo, run, loc.source, owner, !same)
  const witnessJobWorkflow = qualificationKinds.has(kind) ? ISSUER_JOB : same ? jobWorkflow : JOB
  // The consuming deployment authenticates its own ownership, while the
  // qualification artifact independently proves the isolated producer job.
  if (same) {
    if (jobWorkflow === ISSUER_JOB) check(kind === "evidence")
    check((await readAuthenticatedOwner(jobWorkflow)) === owner)
  }
  const artifact = gh("actions/artifacts/" + loc.artifactId),
    w = artifact.workflow_run
  check(
    String(artifact.id) === loc.artifactId &&
      artifact.expired === false &&
      artifact.name === `paired-v1-${loc.runId}-${loc.attempt}-${kind}-${digest}` &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 65536 &&
      w?.id === run.id &&
      w.head_sha === loc.source &&
      w.head_branch === "main" &&
      w.repository_id === repo.id &&
      w.head_repository_id === repo.id
  )
  const timestamp = Date.parse(artifact.created_at)
  check(
    timestamp >= Date.parse(run.run_started_at) &&
      timestamp <= (same ? Date.now() : Date.parse(run.updated_at))
  )
  const zip = gh("actions/artifacts/" + loc.artifactId + "/zip", true)
  check(zip.length === artifact.size_in_bytes && "sha256:" + sha256(zip) === artifact.digest)
  const witness = json(local("python3", ["-I", "-c", unzip], 32768, zip))
  check(witness.version === 1 && witness.kind === kind && witness.digest === digest)
  verifyRecordWitness(
    witness.token,
    await keys(),
    x,
    kind,
    digest,
    Math.floor(timestamp / 1000),
    witnessJobWorkflow
  )
  const raw = privateBytes(dir, digest + ".json")
  check(sha256(raw) === digest && json(raw).kind === kind)
  const body = json(raw)
  if (
    [
      "qualified-release",
      "hold-acquisition",
      "arm",
      "restore",
      "qualified-fleet",
      "held-baseline",
      "promotion-action-lease",
    ].includes(kind)
  )
    check(
      (["qualified-fleet", "held-baseline"].includes(kind) ? body.pair?.owner : body.owner) ===
        owner
    )
  if (kind === "handoff")
    check(
      body.authorization === "original-owner"
        ? body.sourceOwner === owner
        : body.authorization === "approved-takeover" && body.newOwner === owner
    )
  return { raw, owner, source: loc.source, artifactId: loc.artifactId }
}
export async function verifiedArtifact(kind, digest, jobWorkflow = JOB) {
  check(kinds.has(kind) && hash.test(digest))
  const root = process.env.RUNNER_TEMP
  check(root?.startsWith("/"))
  const dir = join(root, "lyrashield-paired-records")
  try {
    return await authenticateRecord(kind, digest, dir, jobWorkflow)
  } catch {
    // Private bounded receipt for authorized recovery, even when no witness exists.
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed protected directory and validated hash/descriptor
      const info = lstatSync(dir)
      check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed protected directory and validated hash/descriptor
      writeFileSync(
        join(dir, kind + "-" + digest + ".unverified.json"),
        JSON.stringify({ version: 1, kind, digest, outcome: "unverified" }),
        { flag: "wx", mode: 0o600 }
      )
    } catch {}
    throw new Error("Protected record provenance unavailable")
  }
}
export async function readProtectedRecord(kind, digest, jobWorkflow = JOB) {
  return (await verifiedArtifact(kind, digest, jobWorkflow)).raw
}
export function verifyCurrentSource() {
  const x = currentRun()
  qualifyReleaseSource({
    repository: REPO,
    sha: x.source,
    api: (endpoint) => {
      const prefix = "repos/" + REPO + "/"
      check(endpoint.startsWith(prefix))
      return gh(endpoint.slice(prefix.length))
    },
  })
  return x
}
export function verifyEnvironmentApproval(owner, expectedSource) {
  const [runId, attempt] = owner.split(":")
  check(id.test(runId) && id.test(attempt) && sha.test(expectedSource))
  const run = gh(`actions/runs/${runId}/attempts/${attempt}`)
  check(run.head_sha === expectedSource && run.run_attempt === Number(attempt))
  // GitHub history does not attach an attempt number to every approval. Bind
  // to a single attempt and fail closed on reruns rather than adopting an old approval.
  check(attempt === "1")
  const reviews = gh(`actions/runs/${runId}/approvals`)
  check(Array.isArray(reviews) && reviews.length > 0 && reviews.length < 100)
  const env = gh("environments/" + ENV)
  check(env.name === ENV && env.protection_rules.some((r) => r.type === "required_reviewers"))
  const relevant = reviews.filter((r) =>
    r.environments?.some((e) => e.id === env.id && e.name === ENV)
  )
  check(
    relevant.length === 1 &&
      relevant[0].state === "approved" &&
      Number.isSafeInteger(relevant[0].user?.id) &&
      relevant[0].user.type === "User"
  )
  return true
}
const unzip = `import io,sys,zipfile,stat
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read(65537)))
files=z.infolist()
assert len(files)==1
f=files[0]
assert f.filename=='paired-witness.json' and 0<f.file_size<=24576 and not (f.flag_bits&1)
assert stat.S_IFMT(f.external_attr >> 16) in (0,stat.S_IFREG)
sys.stdout.buffer.write(z.read(f))`

function engineApi(path) {
  const base = "repos/ecryptoguru/lyrashield-engine"
  return json(local("gh", ["api", "--hostname", "github.com", base + "/" + path]))
}

function protectedEngineApi(path) {
  return json(
    protectedGh(["api", "--hostname", "github.com", "repos/ecryptoguru/lyrashield-engine/" + path])
  )
}

export function verifyHeldEnginePublisherRun(runId, attempt, source, get = protectedEngineApi) {
  check(id.test(runId) && id.test(attempt) && sha.test(source))
  const run = get("actions/runs/" + runId + "/attempts/" + attempt)
  const jobs = get("actions/runs/" + runId + "/attempts/" + attempt + "/jobs?per_page=100")
  const workflowBlob = get("contents/.github/workflows/publish-sandbox.yml?ref=" + source)
  assertExpectedPublisherHold({ run, jobs, workflowBlob }, { source, runId, attempt })
  const current = get("compare/" + source + "...main")
  check(
    current.merge_base_commit?.sha === source && ["ahead", "identical"].includes(current.status)
  )
}

export function verifyEngineRun(runId, attempt, source, workflow) {
  check(
    id.test(runId) &&
      id.test(attempt) &&
      sha.test(source) &&
      ["ci.yml", "publish-sandbox.yml"].includes(workflow)
  )
  const get = engineApi
  const r = get("actions/runs/" + runId + "/attempts/" + attempt)
  check(
    String(r.id) === runId &&
      String(r.run_attempt) === attempt &&
      r.repository?.full_name === "ecryptoguru/lyrashield-engine" &&
      r.head_repository?.id === r.repository?.id &&
      r.head_sha === source &&
      r.status === "completed" &&
      r.path === ".github/workflows/" + workflow
  )
  if (workflow === "publish-sandbox.yml" && r.conclusion === "failure") {
    verifyHeldEnginePublisherRun(runId, attempt, source)
    return
  }
  check(r.conclusion === "success")
  if (workflow === "publish-sandbox.yml") {
    check(
      (r.event === "workflow_dispatch" && r.head_branch === "main") ||
        (r.event === "push" && /^sandbox-v[0-9A-Za-z._-]{1,100}$/.test(r.head_branch))
    )
    const current = get("compare/" + source + "...main")
    check(
      current.merge_base_commit?.sha === source && ["ahead", "identical"].includes(current.status)
    )
  }
}
export function verifySandboxAttestation(p, runId, attempt, { run = protectedGh } = {}) {
  check(
    /^sha256:[a-f0-9]{64}$/.test(p.sandboxDigest) &&
      sha.test(p.engineRevision) &&
      id.test(runId) &&
      id.test(attempt)
  )
  const repo = "ecryptoguru/lyrashield-engine",
    ref = "oci://ghcr.io/ecryptoguru/lyrashield-sandbox@" + p.sandboxDigest
  const rows = json(
    run([
      "attestation",
      "verify",
      ref,
      "--bundle-from-oci",
      "--repo",
      repo,
      "--signer-workflow",
      repo + "/.github/workflows/publish-sandbox.yml",
      "--signer-digest",
      p.engineRevision,
      "--source-digest",
      p.engineRevision,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ])
  )
  check(
    Array.isArray(rows) &&
      rows.some((row) => {
        const s = row.verificationResult?.statement
        return (
          s?.predicateType === "https://slsa.dev/provenance/v1" &&
          s.subject?.some((subject) => subject.digest?.sha256 === p.sandboxDigest.slice(7)) &&
          s.predicate?.runDetails?.metadata?.invocationId ===
            "https://github.com/" + repo + "/actions/runs/" + runId + "/attempts/" + attempt
        )
      })
  )
}
