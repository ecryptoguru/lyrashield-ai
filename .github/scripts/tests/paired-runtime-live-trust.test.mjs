import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, createHash, sign } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { verifyRecordWitness, verifiedArtifact } from "../paired-runtime-github.mjs"
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
  set("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "private-issuance-fixture-012345")
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
    assert.equal(opts.headers.Authorization, "Bearer private-issuance-fixture-012345")
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
