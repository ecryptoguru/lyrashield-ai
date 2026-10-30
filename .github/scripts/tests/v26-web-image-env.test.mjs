import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function qualification(t, header = "reservations/2") {
  const directory = mkdtempSync(join(tmpdir(), "v26-web-env-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = randomBytes(20).toString("hex")
  const engine = randomBytes(20).toString("hex")
  const web = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web:${source}@sha256:${randomBytes(32).toString("hex")}`
  const worker = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${source}@sha256:${randomBytes(32).toString("hex")}`
  const log = join(directory, "docker.jsonl")
  const executable = (name, body) => {
    const path = join(directory, name)
    // Only this test's freshly created disposable executable paths are used.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(path, body)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(path, 0o755)
  }
  executable(
    "docker",
    `#!${process.execPath}
const fs=require("node:fs"),{spawnSync}=require("node:child_process");
const args=process.argv.slice(2);fs.appendFileSync(process.env.V26_ENV_TEST_LOG,JSON.stringify(args)+"\\n");
if(args[0]==="image"){console.log(args.some(value=>value.includes("accounting.protocol"))?"reservations/2":args.some(value=>value.includes("engine.revision"))?process.env.V26_ENV_TEST_ENGINE:process.env.V26_ENV_TEST_SOURCE);process.exit(0)}
if(args[0]==="exec"){
 const code=args[args.indexOf("-e")+1];
 const fetchMock='globalThis.fetch=async()=>({status:503,headers:new Headers({"x-lyrashield-accounting-protocol":'+JSON.stringify(process.env.V26_ENV_TEST_HEADER)+'})});';
 const result=spawnSync(process.execPath,["--input-type=module","-e",fetchMock+code],{encoding:"utf8"});
 process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status);
}
`
  )
  executable("sleep", "#!/bin/sh\nexit 0\n")
  const result = spawnSync(
    "sh",
    [".github/scripts/verify-v26-images.sh", web, worker, source, engine],
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        V26_ENV_TEST_LOG: log,
        V26_ENV_TEST_SOURCE: source,
        V26_ENV_TEST_ENGINE: engine,
        V26_ENV_TEST_HEADER: header,
      },
    }
  )
  // Read only the fixture-owned Docker argument log.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const webRun = calls.find((args) => args[0] === "run" && args.includes(web))
  assert.ok(webRun)
  const environment = Object.fromEntries(
    webRun.flatMap((value, index) => {
      if (value !== "--env") return []
      const setting = webRun[index + 1],
        separator = setting.indexOf("=")
      assert.ok(separator > 0)
      return [[setting.slice(0, separator), setting.slice(separator + 1)]]
    })
  )
  return { result, calls, webRun, environment }
}
const workerRequire = createRequire(new URL("../../../apps/worker/package.json", import.meta.url))
function validateProductionEnvironment(environment) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      workerRequire.resolve("tsx"),
      "--input-type=module",
      "-e",
      'await import("./packages/config/src/env.ts")',
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: process.env.PATH, ...environment },
    }
  )
}

test("captured web qualification Docker env passes the actual production schema without provider credentials", (t) => {
  const { result, calls, webRun, environment } = qualification(t)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /V26_IMAGES_QUALIFIED/)
  assert.equal(webRun[webRun.indexOf("--network") + 1], "none")
  assert.equal(environment.NODE_ENV, "production")
  assert.equal(environment.PLATFORM_ADMIN_EMAILS, "ecryptoguru@gmail.com,ankit@lyrashieldai.com")
  assert.equal(environment.TRUSTED_PROXY_IP_HEADER, "x-forwarded-for")
  assert.ok(environment.IP_HASH_SALT.length >= 32)
  assert.notEqual(environment.IP_HASH_SALT, environment.BETTER_AUTH_SECRET)
  assert.equal(
    Object.keys(environment).some((name) => /OPENAI|AZURE|POLAR|RAZORPAY|TOKEN/.test(name)),
    false
  )
  const valid = validateProductionEnvironment(environment)
  assert.equal(valid.status, 0, valid.stderr)
  for (const name of ["PLATFORM_ADMIN_EMAILS", "TRUSTED_PROXY_IP_HEADER", "IP_HASH_SALT"]) {
    const missing = { ...environment }
    delete missing[name]
    const invalid = validateProductionEnvironment(missing)
    assert.notEqual(invalid.status, 0, `${name} must be required by the real production schema`)
    assert.ok(invalid.stderr.includes(name))
  }
  assert.ok(calls.some((args) => args[0] === "exec" && args.includes("-e")))
})
test("web qualification executes the embedded response/header check and rejects a missing protocol", (t) => {
  const { result } = qualification(t, "")
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /V26_IMAGES_QUALIFIED/)
  assert.match(result.stderr, /Compiled web admission protocol unavailable/)
})
