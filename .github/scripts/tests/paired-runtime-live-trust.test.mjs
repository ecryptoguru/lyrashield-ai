import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, createHash, randomBytes, sign } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  issueRecordWitness,
  verifyRecordWitness,
  verifiedArtifact,
  verifyQualificationIssuerToken,
} from "../paired-runtime-github.mjs"
import { readGuestResult } from "../paired-live-transport.mjs"
import { protectedLiveAdapter } from "../paired-runtime-live.mjs"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const kid = "real-fixture-key",
  keys = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] }
const source = "a".repeat(40),
  owner = "42:1",
  repo = "ecryptoguru/lyrashield-ai"
const x = {
  source,
  owner,
  runId: "42",
  attempt: "1",
  path: ".github/workflows/release-production.yml",
  event: "push",
  repoId: "123",
  ownerId: "77",
}
const raw = JSON.stringify({ kind: "evidence", workspace: "fixture-private" }),
  hash = (v) => createHash("sha256").update(v).digest("hex"),
  digest = hash(raw)
const now = Math.floor(Date.now() / 1000) - 600
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "urn:lyrashield:paired:v1:evidence:" + digest,
  sub: "repo:" + repo + ":environment:azure-production",
  environment: "azure-production",
  repository: repo,
  repository_id: "123",
  repository_owner_id: "77",
  ref: "refs/heads/main",
  sha: source,
  event_name: "push",
  run_id: "42",
  run_attempt: "1",
  runner_environment: "github-hosted",
  workflow_ref: repo + "/" + x.path + "@refs/heads/main",
  workflow_sha: source,
  job_workflow_ref: repo + "/.github/workflows/deploy-azure-runtime.yml@refs/heads/main",
  job_workflow_sha: source,
  iat: now - 5,
  nbf: now - 5,
  exp: now + 60,
}
function jwt(c, alg = "RS256") {
  const base = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const msg = base({ alg, kid }) + "." + base(c)
  return msg + "." + sign("RSA-SHA256", Buffer.from(msg), privateKey).toString("base64url")
}
test("real signature binds issuer, audience, immutable repository, exact run, both trusted workflows and environment", () => {
  verifyRecordWitness(jwt(claims), keys, x, "evidence", digest, now)
  for (const field of [
    "iss",
    "aud",
    "sub",
    "environment",
    "repository",
    "repository_id",
    "repository_owner_id",
    "ref",
    "sha",
    "event_name",
    "run_id",
    "run_attempt",
    "runner_environment",
    "workflow_ref",
    "workflow_sha",
    "job_workflow_ref",
    "job_workflow_sha",
  ])
    assert.throws(() =>
      verifyRecordWitness(jwt({ ...claims, [field]: "foreign" }), keys, x, "evidence", digest, now)
    )
  for (const opts of [
    [jwt(claims, "none"), keys, now],
    [jwt(claims), { keys: [] }, now],
    [jwt(claims), keys, now + 61],
  ])
    assert.throws(() => verifyRecordWitness(opts[0], opts[1], x, "evidence", digest, opts[2]))
  const token = jwt(claims).split(".")
  token[1] = Buffer.from(JSON.stringify({ ...claims, extra: "tampered" })).toString("base64url")
  assert.throws(() => verifyRecordWitness(token.join("."), keys, x, "evidence", digest, now))
})

test("Azure issuer token requires immutable owner, exact main reusable job and qualification environment", () => {
  const identity = {
    ...x,
    repoId: "1286618458",
    ownerId: "116722580",
    path: ".github/workflows/qualify-runtime-issuer.yml",
    event: "workflow_dispatch",
  }
  const valid = {
    ...claims,
    aud: "api://AzureADTokenExchange",
    environment: "release-qualification",
    sub: "repo:" + repo + ":environment:release-qualification",
    repository_id: identity.repoId,
    repository_owner_id: identity.ownerId,
    event_name: identity.event,
    workflow_ref: repo + "/" + identity.path + "@refs/heads/main",
    job_workflow_ref: repo + "/.github/workflows/issue-runtime-qualification.yml@refs/heads/main",
  }
  verifyQualificationIssuerToken(jwt(valid), keys, identity, now)
  for (const field of Object.keys(valid)) {
    assert.throws(() =>
      verifyQualificationIssuerToken(jwt({ ...valid, [field]: "foreign" }), keys, identity, now)
    )
  }
  for (const field of ["repoId", "ownerId"])
    assert.throws(() =>
      verifyQualificationIssuerToken(jwt(valid), keys, { ...identity, [field]: "foreign" }, now)
    )
  assert.throws(() => verifyQualificationIssuerToken(jwt(valid), keys, identity, now + 61))
  assert.throws(() => verifyQualificationIssuerToken(jwt(valid), { keys: [] }, identity, now))
})

test("deployment witnesses cannot issue qualification or automatic approval records", () => {
  for (const kind of [
    "qualified-fleet",
    "qualified-release",
    "sandbox-qualification",
    "financial-qualification",
    "reader-qualification",
    "arm-approval",
    "rebind-approval",
    "handoff",
  ]) {
    const qualified = { ...claims, aud: `urn:lyrashield:paired:v1:${kind}:${digest}` }
    assert.throws(() => verifyRecordWitness(jwt(qualified), keys, x, kind, digest, now))
  }
})

test("deployment qualification issuance fails before requesting an identity token", async (t) => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    throw new Error("No identity request authorized")
  })
  for (const kind of [
    "qualified-fleet",
    "qualified-release",
    "sandbox-qualification",
    "financial-qualification",
    "reader-qualification",
    "arm-approval",
    "rebind-approval",
    "handoff",
  ]) {
    await assert.rejects(issueRecordWitness(kind, JSON.stringify({ kind })))
  }
  assert.equal(requests, 0)
})

test("qualification witnesses bind the isolated issuer job and environment separately from the consumer", () => {
  const kind = "sandbox-qualification"
  const workflow = ".github/workflows/issue-runtime-qualification.yml"
  const qualified = {
    ...claims,
    aud: `urn:lyrashield:paired:v1:${kind}:${digest}`,
    sub: `repo:${repo}:environment:release-qualification`,
    environment: "release-qualification",
    job_workflow_ref: `${repo}/${workflow}@refs/heads/main`,
  }
  verifyRecordWitness(jwt(qualified), keys, x, kind, digest, now, workflow)
  for (const field of [
    "environment",
    "sub",
    "job_workflow_ref",
    "job_workflow_sha",
    "run_attempt",
    "sha",
    "ref",
    "workflow_ref",
  ]) {
    assert.throws(() =>
      verifyRecordWitness(
        jwt({ ...qualified, [field]: "foreign" }),
        keys,
        x,
        kind,
        digest,
        now,
        workflow
      )
    )
  }
  assert.throws(() => verifyRecordWitness(jwt(qualified), keys, x, kind, digest, now))
})

test("issuer evidence witnesses bind the qualification job and never authorize deployment evidence", () => {
  const workflow = ".github/workflows/issue-runtime-qualification.yml"
  const issuerEvidence = {
    ...claims,
    sub: `repo:${repo}:environment:release-qualification`,
    environment: "release-qualification",
    job_workflow_ref: `${repo}/${workflow}@refs/heads/main`,
  }
  verifyRecordWitness(jwt(issuerEvidence), keys, x, "evidence", digest, now, workflow)
  assert.throws(() => verifyRecordWitness(jwt(issuerEvidence), keys, x, "evidence", digest, now))
  for (const field of ["environment", "sub", "job_workflow_ref", "sha", "run_attempt", "aud"]) {
    assert.throws(() =>
      verifyRecordWitness(
        jwt({ ...issuerEvidence, [field]: "foreign" }),
        keys,
        x,
        "evidence",
        digest,
        now,
        workflow
      )
    )
  }
  assert.throws(() => verifyRecordWitness(jwt(claims), keys, x, "evidence", digest, now, workflow))
  for (const kind of ["operation", "continuity", "hold-acquisition"])
    assert.throws(() =>
      verifyRecordWitness(
        jwt({ ...issuerEvidence, aud: `urn:lyrashield:paired:v1:${kind}:${digest}` }),
        keys,
        x,
        kind,
        digest,
        now,
        workflow
      )
    )
})

test("consumer-only held baseline and action lease require signed isolated issuer provenance", async (t) => {
  const workflow = ".github/workflows/issue-runtime-qualification.yml"
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    throw new Error("must not sign")
  })
  for (const kind of ["held-baseline", "promotion-action-lease"]) {
    const qualified = {
      ...claims,
      aud: `urn:lyrashield:paired:v1:${kind}:${digest}`,
      sub: `repo:${repo}:environment:release-qualification`,
      environment: "release-qualification",
      job_workflow_ref: `${repo}/${workflow}@refs/heads/main`,
    }
    verifyRecordWitness(jwt(qualified), keys, x, kind, digest, now, workflow)
    assert.throws(() => verifyRecordWitness(jwt(qualified), keys, x, kind, digest, now))
    for (const field of [
      "environment",
      "sub",
      "job_workflow_ref",
      "run_id",
      "run_attempt",
      "sha",
      "aud",
    ]) {
      assert.throws(() =>
        verifyRecordWitness(
          jwt({ ...qualified, [field]: "foreign" }),
          keys,
          x,
          kind,
          digest,
          now,
          workflow
        )
      )
    }
    assert.throws(() =>
      verifyRecordWitness(jwt(qualified), { keys: [] }, x, kind, digest, now, workflow)
    )
    await assert.rejects(issueRecordWitness(kind, JSON.stringify({ kind }), workflow))
  }
  assert.equal(requests, 0)
})

test("historical artifact uses real bounded ZIP plus signed witness, refuses substituted archive, locator, raw body and expired issuance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "paired-record-")),
    dir = join(root, "lyrashield-paired-records")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  mkdirSync(dir, { mode: 0o700 })
  function put(file, data, mode = 0o600) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
    writeFileSync(join(dir, file), data, { mode })
  }
  function zip(entries) {
    return execFileSync(
      "python3",
      [
        "-I",
        "-c",
        'import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())',
      ],
      { input: JSON.stringify(entries) }
    )
  }
  const locator = { runId: "42", attempt: "1", artifactId: "11", source }
  put(digest + ".locator.json", JSON.stringify(locator))
  put(digest + ".json", raw)
  const fixtureRepo = { id: 123, full_name: repo, owner: { id: 77, login: "ecryptoguru" } }
  const ts = (s) => new Date(s * 1000).toISOString()
  const run = {
    id: 42,
    head_sha: source,
    run_attempt: 1,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: x.path,
    repository: fixtureRepo,
    head_repository: fixtureRepo,
    run_started_at: ts(now - 40),
    updated_at: ts(now + 20),
  }
  const witness = { version: 1, kind: "evidence", digest, token: jwt(claims) }
  const ghfake = join(root, "gh")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    ghfake,
    `#!/usr/bin/env node
const fs=require("node:fs"),args=process.argv.slice(2),k=args.at(-1);const base=process.env.RUNNER_TEMP+"/lyrashield-paired-records/"
const paths={"repos/ecryptoguru/lyrashield-ai":"repo","repos/ecryptoguru/lyrashield-ai/actions/runs/42/attempts/1":"run","repos/ecryptoguru/lyrashield-ai/actions/artifacts/11":"artifact","repos/ecryptoguru/lyrashield-ai/actions/artifacts/11/zip":"zip"}
if(!Object.hasOwn(paths,k))process.exit(19);process.stdout.write(fs.readFileSync(base+paths[k]))`,
    { mode: 0o700 }
  )
  put("repo", JSON.stringify(fixtureRepo))
  put("run", JSON.stringify(run))
  const env = { PATH: process.env.PATH, RUNNER_TEMP: process.env.RUNNER_TEMP }
  process.env.PATH = root + ":" + env.PATH
  process.env.RUNNER_TEMP = root
  t.after(() => {
    process.env.PATH = env.PATH
    if (env.RUNNER_TEMP === undefined) delete process.env.RUNNER_TEMP
    else process.env.RUNNER_TEMP = env.RUNNER_TEMP
  })
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks")
    return new Response(JSON.stringify(keys))
  })
  const fresh = (entries = { "paired-witness.json": JSON.stringify(witness) }, over = {}) => {
    const z = zip(entries)
    put("zip", z)
    put(
      "artifact",
      JSON.stringify({
        id: 11,
        expired: false,
        name: "paired-v1-42-1-evidence-" + digest,
        created_at: ts(now),
        size_in_bytes: z.length,
        digest: "sha256:" + hash(z),
        workflow_run: {
          id: 42,
          head_sha: source,
          head_branch: "main",
          repository_id: 123,
          head_repository_id: 123,
        },
        ...over,
      })
    )
  }
  fresh()
  assert.equal((await verifiedArtifact("evidence", digest)).raw, raw)
  for (const over of [
    { expired: true },
    { digest: "sha256:" + "0".repeat(64) },
    { name: "copied-from-pr" },
    { created_at: ts(now + 60) },
  ]) {
    fresh(undefined, over)
    await assert.rejects(verifiedArtifact("evidence", digest))
  }
  fresh({ "paired-witness.json": JSON.stringify(witness), extra: "smuggled" })
  await assert.rejects(verifiedArtifact("evidence", digest))
  fresh({
    "paired-witness.json": JSON.stringify({
      ...witness,
      token: jwt({ ...claims, environment: "unprotected" }),
    }),
  })
  await assert.rejects(verifiedArtifact("evidence", digest))
  fresh()
  put(digest + ".json", JSON.stringify({ ...JSON.parse(raw), extra: true }))
  await assert.rejects(verifiedArtifact("evidence", digest))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  const failure = readFileSync(join(dir, "evidence-" + digest + ".unverified.json"), "utf8")
  assert.deepEqual(JSON.parse(failure), {
    version: 1,
    kind: "evidence",
    digest,
    outcome: "unverified",
  })
  assert.ok(!failure.includes(claims.sub) && !failure.includes("fixture-private"))
})

test("guest receipts require one terminal current nonce on successful stdout; persistence cannot be inferred from two Redis reads", async () => {
  const n = "f".repeat(64),
    line = "PAIRED_RESULT " + n + " " + Buffer.from("true").toString("base64")
  const data = (msg) =>
    JSON.stringify({ value: [{ code: "ComponentStatus/StdOut/succeeded", message: msg }] })
  assert.equal(readGuestResult(data("[stdout]\n" + line + "\n[stderr]\nbenign"), n), true)
  for (const msg of [
    line.replace(n, "0".repeat(64)),
    line + "\n" + line,
    "[stderr]\n" + line,
    line + "\nmore",
  ])
    assert.throws(() => readGuestResult(data(msg), n))
  const a = protectedLiveAdapter()
  await assert.rejects(a.verifyAcquisitionContinuity(), /history unavailable/)
  await assert.rejects(a.proveReboundContinuity(), /history unavailable/)
})

test("current authority must join the live main ref, exact Git object, active repo run and signed environment-bound job", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paired-owner-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    old = {}
  const set = (k, v) => {
    if (!Object.hasOwn(old, k)) old[k] = process.env[k]
    process.env[k] = v
  }
  set("PATH", dir + ":" + process.env.PATH)
  set("PAIRED_TEST_ROOT", dir)
  set("GITHUB_SHA", actual)
  set("GITHUB_REPOSITORY", repo)
  set("GITHUB_REF", "refs/heads/main")
  set("GITHUB_RUN_ID", "42")
  set("GITHUB_RUN_ATTEMPT", "1")
  set(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "https://issuer-test.actions.githubusercontent.com/private/idtoken"
  )
  const requestToken = randomBytes(24).toString("hex")
  set("ACTIONS_ID_TOKEN_REQUEST_TOKEN", requestToken)
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  const setMain = (v) => writeFileSync(join(dir, "main"), JSON.stringify({ object: { sha: v } }))
  const metadata = { id: 123, full_name: repo, owner: { id: 77, login: "ecryptoguru" } }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(dir, "repo"), JSON.stringify(metadata))
  const run = {
    id: 42,
    head_sha: actual,
    run_attempt: 1,
    head_branch: "main",
    event: "push",
    status: "in_progress",
    conclusion: null,
    path: x.path,
    repository: metadata,
    head_repository: metadata,
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(dir, "run"), JSON.stringify(run))
  setMain(actual)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
const files={"repos/ecryptoguru/lyrashield-ai":"repo","repos/ecryptoguru/lyrashield-ai/git/ref/heads/main":"main","repos/ecryptoguru/lyrashield-ai/actions/runs/42":"run"}
const file=files[process.argv.at(-1)];if(!file)process.exit(19);process.stdout.write(require("node:fs").readFileSync(process.env.PAIRED_TEST_ROOT+"/"+file))`,
    { mode: 0o700 }
  )
  let drift = {}
  t.mock.method(globalThis, "fetch", async (value, opts) => {
    const url = new URL(value)
    if (url.hostname === "token.actions.githubusercontent.com")
      return new Response(JSON.stringify(keys))
    assert.equal(url.hostname, "issuer-test.actions.githubusercontent.com")
    assert.equal(opts.headers.Authorization, `Bearer ${requestToken}`)
    const n = Math.floor(Date.now() / 1000)
    return new Response(
      JSON.stringify({
        value: jwt({
          ...claims,
          aud: url.searchParams.get("audience"),
          sha: actual,
          workflow_sha: actual,
          job_workflow_sha: actual,
          iat: n - 1,
          nbf: n - 1,
          exp: n + 60,
          ...drift,
        }),
      })
    )
  })
  const { readAuthenticatedOwner } = await import("../paired-runtime-github.mjs")
  assert.equal(await readAuthenticatedOwner(), owner)
  drift = { job_workflow_ref: repo + "/.github/workflows/deploy-azure.yml@refs/heads/main" }
  assert.equal(await readAuthenticatedOwner(".github/workflows/deploy-azure.yml"), owner)
  await assert.rejects(readAuthenticatedOwner())
  await assert.rejects(readAuthenticatedOwner(".github/workflows/untrusted.yml"))
  drift = {}
  setMain("0".repeat(40))
  await assert.rejects(readAuthenticatedOwner())
  setMain(actual)
  drift = { job_workflow_sha: "0".repeat(40) }
  await assert.rejects(readAuthenticatedOwner())
  drift = {}
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(join(dir, "run"), JSON.stringify({ ...run, run_attempt: 2 }))
  await assert.rejects(readAuthenticatedOwner())
})

test("caller workflow identity threads through owner, witness and protected artifact verification", async (t) => {
  const callerPath = ".github/workflows/deploy-azure.yml"
  const root = mkdtempSync(join(tmpdir(), "paired-caller-identity-"))
  const records = join(root, "lyrashield-paired-records")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  mkdirSync(records, { mode: 0o700 })
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const caller = repo + "/" + callerPath + "@refs/heads/main"
  const artifactRepo = {
    id: 1286618458,
    full_name: repo,
    owner: { id: 116722580, login: "ecryptoguru" },
  }
  const identity = {
    source: actual,
    owner,
    runId: "42",
    attempt: "1",
    path: x.path,
    event: "push",
    repoId: String(artifactRepo.id),
    ownerId: String(artifactRepo.owner.id),
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  const makeClaims = (aud) => ({
    ...claims,
    aud,
    repository_id: identity.repoId,
    repository_owner_id: identity.ownerId,
    sha: actual,
    workflow_sha: actual,
    job_workflow_ref: caller,
    job_workflow_sha: actual,
    iat: nowSeconds - 2,
    nbf: nowSeconds - 2,
    exp: nowSeconds + 120,
  })
  const body = JSON.stringify({ kind: "evidence", workspace: "caller-private" })
  const bodyDigest = hash(body)
  const ownerToken = jwt(makeClaims("urn:lyrashield:paired:v1:owner:42:1"))
  const witnessToken = jwt(makeClaims("urn:lyrashield:paired:v1:evidence:" + bodyDigest))
  const locator = { runId: "42", attempt: "1", artifactId: "11", source: actual }
  const ts = (seconds) => new Date(seconds * 1000).toISOString()
  const run = {
    id: 42,
    head_sha: actual,
    run_attempt: 1,
    head_branch: "main",
    event: "push",
    status: "in_progress",
    conclusion: null,
    path: x.path,
    repository: artifactRepo,
    head_repository: artifactRepo,
    run_started_at: ts(nowSeconds - 40),
    updated_at: ts(nowSeconds + 20),
  }
  const witness = { version: 1, kind: "evidence", digest: bodyDigest, token: witnessToken }
  const archive = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      'import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("paired-witness.json",sys.stdin.read()); z.close(); sys.stdout.buffer.write(b.getvalue())',
    ],
    { input: JSON.stringify(witness) }
  )
  const files = {
    repo: JSON.stringify(artifactRepo),
    main: JSON.stringify({ object: { sha: actual } }),
    run: JSON.stringify(run),
    attempt: JSON.stringify(run),
    zip: archive,
    artifact: JSON.stringify({
      id: 11,
      expired: false,
      name: "paired-v1-42-1-evidence-" + bodyDigest,
      created_at: ts(nowSeconds),
      size_in_bytes: archive.length,
      digest: "sha256:" + hash(archive),
      workflow_run: {
        id: 42,
        head_sha: actual,
        head_branch: "main",
        repository_id: artifactRepo.id,
        head_repository_id: artifactRepo.id,
      },
    }),
  }
  const put = (name, value, mode = 0o600) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
    writeFileSync(join(records, name), value, { mode })
  }
  put(bodyDigest + ".locator.json", JSON.stringify(locator))
  put(bodyDigest + ".json", body)
  put("zip", files.zip)
  for (const name of ["repo", "main", "run", "attempt", "artifact"]) put(name, files[name])
  const ghfake = join(root, "gh")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- private generated test fixture path
  writeFileSync(
    ghfake,
    `#!/usr/bin/env node
const fs=require("node:fs"),path=process.argv.at(-1),root=process.env.RUNNER_TEMP+"/lyrashield-paired-records/"
const map={
  "repos/ecryptoguru/lyrashield-ai":"repo",
  "repos/ecryptoguru/lyrashield-ai/git/ref/heads/main":"main",
  "repos/ecryptoguru/lyrashield-ai/actions/runs/42":"run",
  "repos/ecryptoguru/lyrashield-ai/actions/runs/42/attempts/1":"attempt",
  "repos/ecryptoguru/lyrashield-ai/actions/artifacts/11":"artifact",
  "repos/ecryptoguru/lyrashield-ai/actions/artifacts/11/zip":"zip"
}
if(!Object.hasOwn(map,path))process.exit(19)
process.stdout.write(fs.readFileSync(root+map[path]))`,
    { mode: 0o700 }
  )
  const previous = {}
  const set = (key, value) => {
    if (!Object.hasOwn(previous, key)) previous[key] = process.env[key]
    process.env[key] = value
  }
  set("PATH", root + ":" + process.env.PATH)
  set("RUNNER_TEMP", root)
  set("GITHUB_SHA", actual)
  set("GITHUB_REPOSITORY", repo)
  set("GITHUB_REF", "refs/heads/main")
  set("GITHUB_RUN_ID", "42")
  set("GITHUB_RUN_ATTEMPT", "1")
  set(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "https://issuer-caller.actions.githubusercontent.com/private/idtoken"
  )
  set("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "caller-request-token-value")
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  t.mock.method(globalThis, "fetch", async (value) => {
    const url = new URL(value)
    if (url.hostname === "token.actions.githubusercontent.com")
      return new Response(JSON.stringify(keys))
    assert.equal(url.hostname, "issuer-caller.actions.githubusercontent.com")
    return new Response(JSON.stringify({ value: ownerToken }))
  })
  const { readAuthenticatedOwner } = await import("../paired-runtime-github.mjs")
  assert.equal(await readAuthenticatedOwner(callerPath), owner)
  assert.doesNotThrow(() =>
    verifyRecordWitness(
      witnessToken,
      keys,
      identity,
      "evidence",
      bodyDigest,
      nowSeconds,
      callerPath
    )
  )
  assert.equal((await verifiedArtifact("evidence", bodyDigest, callerPath)).raw, body)
  await assert.rejects(verifiedArtifact("evidence", bodyDigest))

  // A qualification producer is a different protected job in this run;
  // consuming it still requires the deployment job's own owner witness.
  const qualificationKind = "sandbox-qualification"
  const qualificationBody = JSON.stringify({ kind: qualificationKind, owner })
  const qualificationDigest = hash(qualificationBody)
  const qualificationAudience =
    "urn:lyrashield:paired:v1:" + qualificationKind + ":" + qualificationDigest
  const issuerPath = ".github/workflows/issue-runtime-qualification.yml"
  const issuerClaims = {
    ...makeClaims(qualificationAudience),
    sub: `repo:${repo}:environment:release-qualification`,
    environment: "release-qualification",
    job_workflow_ref: repo + "/" + issuerPath + "@refs/heads/main",
  }
  put(qualificationDigest + ".locator.json", JSON.stringify(locator))
  put(qualificationDigest + ".json", qualificationBody)
  const replaceQualificationWitness = (token) => {
    const bytes = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        'import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("paired-witness.json",sys.stdin.read()); z.close(); sys.stdout.buffer.write(b.getvalue())',
      ],
      {
        input: JSON.stringify({
          version: 1,
          kind: qualificationKind,
          digest: qualificationDigest,
          token,
        }),
      }
    )
    put("zip", bytes)
    put(
      "artifact",
      JSON.stringify({
        ...JSON.parse(files.artifact),
        name: "paired-v1-42-1-" + qualificationKind + "-" + qualificationDigest,
        size_in_bytes: bytes.length,
        digest: "sha256:" + hash(bytes),
      })
    )
  }
  replaceQualificationWitness(jwt(issuerClaims))
  t.mock.method(globalThis, "fetch", async (value) => {
    const url = new URL(value)
    if (url.hostname === "token.actions.githubusercontent.com")
      return new Response(JSON.stringify(keys))
    assert.equal(url.hostname, "issuer-caller.actions.githubusercontent.com")
    const aud = url.searchParams.get("audience")
    assert.ok(aud === qualificationAudience || aud === "urn:lyrashield:paired:v1:owner:42:1")
    return new Response(
      JSON.stringify({ value: aud === qualificationAudience ? jwt(issuerClaims) : ownerToken })
    )
  })
  const issued = JSON.parse(
    await issueRecordWitness(qualificationKind, qualificationBody, issuerPath)
  )
  assert.equal(issued.kind, qualificationKind)
  assert.equal(issued.digest, qualificationDigest)
  assert.doesNotThrow(() =>
    verifyRecordWitness(
      issued.token,
      keys,
      identity,
      qualificationKind,
      qualificationDigest,
      nowSeconds,
      issuerPath
    )
  )
  assert.equal(
    (await verifiedArtifact(qualificationKind, qualificationDigest, callerPath)).raw,
    qualificationBody
  )
  await assert.rejects(verifiedArtifact(qualificationKind, qualificationDigest))
  replaceQualificationWitness(jwt(makeClaims(qualificationAudience)))
  await assert.rejects(verifiedArtifact(qualificationKind, qualificationDigest, callerPath))

  // The fleet issuer reads evidence produced by its own protected run.
  const evidenceAudience = "urn:lyrashield:paired:v1:evidence:" + bodyDigest
  const issuerEvidenceClaims = {
    ...makeClaims(evidenceAudience),
    sub: `repo:${repo}:environment:release-qualification`,
    environment: "release-qualification",
    job_workflow_ref: repo + "/" + issuerPath + "@refs/heads/main",
  }
  const issuerEvidenceWitness = jwt(issuerEvidenceClaims)
  const issuerArchive = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      'import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("paired-witness.json",sys.stdin.read()); z.close(); sys.stdout.buffer.write(b.getvalue())',
    ],
    {
      input: JSON.stringify({
        version: 1,
        kind: "evidence",
        digest: bodyDigest,
        token: issuerEvidenceWitness,
      }),
    }
  )
  put("zip", issuerArchive)
  put(
    "artifact",
    JSON.stringify({
      ...JSON.parse(files.artifact),
      size_in_bytes: issuerArchive.length,
      digest: "sha256:" + hash(issuerArchive),
    })
  )
  t.mock.method(globalThis, "fetch", async (value) => {
    const url = new URL(value)
    if (url.hostname === "token.actions.githubusercontent.com")
      return new Response(JSON.stringify(keys))
    const aud = url.searchParams.get("audience")
    return new Response(JSON.stringify({ value: jwt({ ...issuerEvidenceClaims, aud }) }))
  })
  const issuerWitness = JSON.parse(await issueRecordWitness("evidence", body, issuerPath))
  assert.equal(issuerWitness.digest, bodyDigest)
  assert.equal((await verifiedArtifact("evidence", bodyDigest, issuerPath)).raw, body)
  await assert.rejects(verifiedArtifact("evidence", bodyDigest, callerPath))
  await assert.rejects(verifiedArtifact("evidence", bodyDigest))
  replaceQualificationWitness(jwt(issuerClaims))
  await assert.rejects(verifiedArtifact(qualificationKind, qualificationDigest, issuerPath))

  // A completed historical run uses the same issuer policy, without
  // confusing the later consumer's run identity with the issuing run.
  set("GITHUB_RUN_ID", "43")
  put("attempt", JSON.stringify({ ...run, status: "completed", conclusion: "success" }))
  replaceQualificationWitness(jwt(issuerClaims))
  assert.equal(
    (await verifiedArtifact(qualificationKind, qualificationDigest, callerPath)).raw,
    qualificationBody
  )
  replaceQualificationWitness(jwt(makeClaims(qualificationAudience)))
  await assert.rejects(verifiedArtifact(qualificationKind, qualificationDigest, callerPath))
})
