/* eslint-disable security/detect-non-literal-fs-filename -- Fixture paths are created under owned mkdtemp directories and never use production data. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import {
  boundedFetch,
  isolatedEnvironment,
  LIMITS,
  ownedArchivePath,
  REQUIRED_TOOLS,
  runOwnedProcess,
  validateCatalog,
  verifyIntegrity,
  verifyPublishedMcp,
  verifyStdio,
} from "../verify-published-mcp.mjs"

const directories = []
after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})
async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "lyrashield-verifier-test-"))
  directories.push(directory)
  return directory
}
function propertySchema(contract) {
  if (typeof contract === "string") return { type: contract }
  return {
    ...contract,
    ...(contract.items ? { items: propertySchema(contract.items) } : {}),
    ...(contract.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(contract.properties).map(([name, value]) => [
              name,
              propertySchema(value),
            ])
          ),
        }
      : {}),
  }
}
const tools = () =>
  Object.entries(REQUIRED_TOOLS).map(([name, contract]) => ({
    name,
    inputSchema: {
      type: "object",
      required: contract.required,
      properties: Object.fromEntries(
        Object.entries(contract.properties).map(([key, value]) => [key, propertySchema(value)])
      ),
    },
  }))
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-06-18",
    serverInfo: { name: "fixture", version: "1" },
    capabilities: { tools: {} },
  },
}
function fixture({
  catalog = tools(),
  before = "",
  initializeMessage = initialize,
  response,
  tail = "",
} = {}) {
  return `import readline from 'node:readline'; ${before}
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === 1) process.stdout.write(${JSON.stringify(JSON.stringify(initializeMessage) + "\n")});
      if (request.id === 2) { ${response ?? `process.stdout.write(${JSON.stringify(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: catalog } }) + "\n")});`} ${tail} }
    });`
}
async function probe(program, options = {}) {
  const directory = await temporary()
  return verifyStdio(process.execPath, ["--input-type=module", "-e", program], {
    cwd: directory,
    env: await isolatedEnvironment(directory),
    timeoutMs: 750,
    terminateMs: 50,
    ...options,
  })
}

test("isolated environment excludes inherited credentials and runtime injection", async () => {
  const previous = Object.fromEntries(
    ["NODE_OPTIONS", "NPM_TOKEN", "OPENAI_API_KEY"].map((key) => [key, process.env[key]])
  )
  process.env.NODE_OPTIONS = "--throw-deprecation"
  process.env.NPM_TOKEN = "sentinel-private-token"
  process.env.OPENAI_API_KEY = "sentinel-private-provider"
  try {
    const directory = await temporary()
    const env = await isolatedEnvironment(directory)
    const { stdout } = await runOwnedProcess(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { cwd: directory, env, timeoutMs: 750, terminateMs: 50 }
    )
    const child = JSON.parse(stdout)
    for (const key of [
      "NODE_OPTIONS",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "LYRASHIELD_OAUTH_ACCESS_TOKEN",
    ])
      assert.equal(child[key], undefined)
    assert.equal(child.npm_config_ignore_scripts, "true")
    assert.equal(child.LYRASHIELD_API_URL, "http://127.0.0.1:9")
    assert.ok(child.HOME.startsWith(directory + path.sep))
    assert.ok(child.npm_config_userconfig.startsWith(directory + path.sep))
    assert.equal(await readFile(child.npm_config_userconfig, "utf8"), "")
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("healthy initialization accepts required subset and additional legitimate tools", async () => {
  await probe(
    fixture({
      catalog: [...tools(), { name: "future_tool", inputSchema: { type: "object" } }],
    })
  )
})

test("stderr flood is drained and retained diagnostics are bounded and redacted", async () => {
  await probe(fixture({ before: `process.stderr.write('x'.repeat(200000));` }))
  await assert.rejects(
    probe(
      `process.stderr.write('Bearer private-value\\napi_key=private-key\\n' + 'lsk_' + 'A'.repeat(24) + '\\n' + 'x'.repeat(200000)); setInterval(()=>{},1000)`
    ),
    (error) => {
      assert.match(error.message, /timed out/)
      assert.match(error.message, /\[REDACTED\]/)
      assert.ok(!error.message.includes("private-value") && !error.message.includes("private-key"))
      assert.ok(error.message.length < LIMITS.stderrBytes + 200)
      return true
    }
  )
})

test("hang and ignored SIGTERM reject within deadline plus escalation", async () => {
  for (const program of [
    "setInterval(()=>{},1000)",
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
  ]) {
    const started = performance.now()
    await assert.rejects(probe(program, { timeoutMs: 250 }), /timed out/)
    assert.ok(performance.now() - started < 1500)
  }
})

test("owned descendant holding stdio pipes is killed and does not delay settlement", async () => {
  const directory = await temporary()
  const pidPath = path.join(directory, "descendant.pid")
  const program = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});
    writeFileSync(${JSON.stringify(pidPath)},String(child.pid)); setTimeout(()=>process.exit(0),100);`
  const started = performance.now()
  await runOwnedProcess(process.execPath, ["-e", program], {
    cwd: directory,
    env: await isolatedEnvironment(directory),
    timeoutMs: 750,
    terminateMs: 50,
  })
  assert.ok(performance.now() - started < 1500)
  const pid = Number(await readFile(pidPath, "utf8"))
  // SIGKILL is delivered before settlement; wait briefly for the kernel to reap.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      assert.equal(error.code, "ESRCH")
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("owned descendant survived termination")
})

test("cleanup never signals an unrelated process group", async () => {
  const directory = await temporary()
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
    env: await isolatedEnvironment(directory),
  })
  try {
    await assert.rejects(probe("setInterval(()=>{},1000)", { timeoutMs: 100 }), /timed out/)
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
  } finally {
    process.kill(-unrelated.pid, "SIGKILL")
  }
})

test("malformed, invalid RPC, wrong protocol and oversized frames fail", async () => {
  for (const [options, pattern] of [
    [{ response: "process.stdout.write('not json\\n')" }, /non-JSON-RPC/],
    [{ initializeMessage: { ...initialize, jsonrpc: "1.0" } }, /invalid JSON-RPC/],
    [
      { initializeMessage: { ...initialize, error: { code: -1, message: "bad" } } },
      /invalid JSON-RPC/,
    ],
    [{ initializeMessage: { ...initialize, id: 2 } }, /invalid JSON-RPC/],
    [
      {
        initializeMessage: {
          ...initialize,
          result: { ...initialize.result, protocolVersion: "invalid" },
        },
      },
      /initialization failed/,
    ],
    [{ response: "process.stdout.write('x'.repeat(16384))" }, /frame exceeded/],
    [{ response: "process.stdout.write('x'.repeat(16384)+'\\n')" }, /frame exceeded/],
    [
      {
        response: `process.stdout.write(${JSON.stringify(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: tools() } }) + "\ntrailing")})`,
      },
      /incomplete frame/,
    ],
    [{ response: "process.stdout.write(Buffer.from([255,10]))" }, /non-JSON-RPC/],
  ])
    await assert.rejects(probe(fixture(options), { frameBytes: 8192 }), pattern)
})

test("missing tool, duplicate names, added required input and incompatible schema fail", async () => {
  const missing = tools().filter((tool) => tool.name !== "lyrashield_scan_target")
  await assert.rejects(probe(fixture({ catalog: missing })), /missing lyrashield_scan_target/)
  const wrong = tools()
  wrong[1].inputSchema.properties.workspaceId.type = "number"
  await assert.rejects(probe(fixture({ catalog: wrong })), /schema is incompatible/)
  const required = tools()
  required[1].inputSchema.properties.newInput = { type: "string" }
  required[1].inputSchema.required = [...required[1].inputSchema.required, "newInput"]
  assert.throws(() => validateCatalog(required), /schema is incompatible/)
  assert.throws(() => validateCatalog([...tools(), tools()[0]]), /duplicate/)
})

test("published catalog requires eligibility preflight used by scan workflows", () => {
  const catalog = tools().filter((tool) => tool.name !== "lyrashield_get_scan_eligibility")
  assert.throws(() => validateCatalog(catalog), /missing lyrashield_get_scan_eligibility/)
})

const retryFields = [
  ["lyrashield_run_pr_scan", "idempotencyKey"],
  ["lyrashield_verify_fix", "idempotencyKey"],
  ["lyrashield_record_fix_proposal", "idempotencyKey"],
  ["lyrashield_get_scan_status", "operationId"],
]
for (const [name, property] of retryFields) {
  test(`published catalog requires compatible ${name}.${property}`, () => {
    const catalog = tools()
    // Explicit fixture adds the retry contract independently of REQUIRED_TOOLS.
    const required =
      name === "lyrashield_run_pr_scan"
        ? ["workspaceId"]
        : name === "lyrashield_verify_fix"
          ? ["workspaceId", "findingId"]
          : name === "lyrashield_record_fix_proposal"
            ? ["workspaceId", "findingId", "summary"]
            : ["workspaceId"]
    let tool = catalog.find((tool) => tool.name === name)
    if (!tool) {
      tool = {
        name,
        inputSchema: {
          type: "object",
          required,
          properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
        },
      }
      catalog.push(tool)
    }
    if (name === "lyrashield_run_pr_scan") {
      Object.assign(tool.inputSchema.properties, {
        targetId: { type: "string" },
        repo: { type: "string" },
        auto: { type: "boolean" },
      })
    }
    tool.inputSchema.properties[property] = { type: "string" }
    validateCatalog(catalog)
    delete tool.inputSchema.properties[property]
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
    tool.inputSchema.properties[property] = { type: "number" }
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
    tool.inputSchema.properties[property] = { type: "string", maxLength: 1 }
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
  })
}

const authoredFields = [
  ["lyrashield_get_scan_eligibility", "goal"],
  ["lyrashield_get_scan_eligibility", "mode"],
  ["lyrashield_get_scan_eligibility", "workflow"],
  ["lyrashield_scan_target", "goal"],
  ["lyrashield_scan_target", "mode"],
  ["lyrashield_scan_target", "workflow"],
  ["lyrashield_run_pr_scan", "mode"],
  ["lyrashield_run_pr_scan", "workflow"],
  ["lyrashield_get_launch_readiness", "commit"],
  ["lyrashield_get_launch_readiness", "artifactDigest"],
  ["lyrashield_check_diff", "files"],
]
for (const [name, property] of authoredFields) {
  test(`published catalog requires optional authored input ${name}.${property}`, () => {
    const catalog = tools()
    const schema = catalog.find((tool) => tool.name === name).inputSchema
    const original = schema.properties[property]
    delete schema.properties[property]
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
    schema.properties[property] = original
    schema.required = [...schema.required, property]
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
  })
}

const eligibilityEnums = {
  goal: [
    "CHECK_PR",
    "TEST_APP",
    "LAUNCH_REVIEW",
    "WEEKLY_MONITOR",
    "FULL_PENTEST",
    "COMPLIANCE_REVIEW",
  ],
  mode: ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"],
}
test("published eligibility accepts full, broader, and unconstrained source enum inputs", () => {
  for (const [property, values] of Object.entries(eligibilityEnums)) {
    const catalog = tools()
    const properties = catalog.find((tool) => tool.name === "lyrashield_get_scan_eligibility")
      .inputSchema.properties
    properties[property] = { type: "string", enum: [...values] }
    validateCatalog(catalog)
    properties[property].enum.push("FUTURE_VALUE")
    validateCatalog(catalog)
    delete properties[property].enum
    validateCatalog(catalog)
  }
})

for (const [property, values] of Object.entries(eligibilityEnums)) {
  test(`published eligibility ${property} must retain every accepted value`, () => {
    for (const missing of values) {
      const catalog = tools()
      catalog.find(
        (tool) => tool.name === "lyrashield_get_scan_eligibility"
      ).inputSchema.properties[property] = {
        type: "string",
        enum: values.filter((value) => value !== missing),
      }
      assert.throws(() => validateCatalog(catalog), /schema is incompatible/, missing)
    }
  })
}
for (const [name, property] of authoredFields.filter(([, property]) =>
  ["goal", "mode", "workflow"].includes(property)
)) {
  test(`published ${name}.${property} rejects restrictive enums`, () => {
    const catalog = tools()
    catalog.find((tool) => tool.name === name).inputSchema.properties[property] = {
      type: "string",
      enum: ["QUICK"],
    }
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
  })
}

test("advisory file snapshots require path and content schemas", () => {
  for (const property of ["path", "content"]) {
    const catalog = tools()
    catalog.find((tool) => tool.name === "lyrashield_check_diff").inputSchema.properties.files = {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    }
    const item = catalog.find((tool) => tool.name === "lyrashield_check_diff").inputSchema
      .properties.files.items
    item.properties[property] = { type: "number" }
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
  }
})

test("required schema assertions cannot narrow supported inputs", () => {
  for (const [name, property, narrowing] of [
    ["lyrashield_scan_target", "auto", { const: false }],
    ["lyrashield_scan_target", "auto", { enum: [false] }],
    ["lyrashield_scan_target", "workspaceId", { minLength: 100 }],
    ["lyrashield_scan_target", "workspaceId", { maxLength: 1 }],
    ["lyrashield_scan_target", "workspaceId", { pattern: "^forbidden$" }],
    ["lyrashield_scan_target", "idempotencyKey", { maxLength: 1 }],
    ["lyrashield_scan_target", "idempotencyKey", { minLength: 2 }],
    ["lyrashield_list_targets", "limit", { minimum: 2 }],
    ["lyrashield_list_targets", "limit", { maximum: 99 }],
  ]) {
    const catalog = tools()
    Object.assign(
      catalog.find((tool) => tool.name === name).inputSchema.properties[property],
      narrowing
    )
    assert.throws(
      () => validateCatalog(catalog),
      /schema is incompatible/,
      `${name}.${property} ${JSON.stringify(narrowing)}`
    )
  }
  for (const narrowing of [
    { allOf: [{ properties: { auto: { const: false } } }] },
    { not: { properties: { auto: { const: true } } } },
    { minProperties: 20 },
    { dependentRequired: { auto: ["targetId"] } },
  ]) {
    const catalog = tools()
    Object.assign(
      catalog.find((tool) => tool.name === "lyrashield_scan_target").inputSchema,
      narrowing
    )
    assert.throws(() => validateCatalog(catalog), /schema is incompatible/)
  }
})

test("modeled property bounds and broader compatible schemas pass", () => {
  const catalog = tools()
  const scan = catalog.find((tool) => tool.name === "lyrashield_scan_target").inputSchema
  scan.properties.auto.enum = [true, false]
  Object.assign(scan.properties.idempotencyKey, { minLength: 1, maxLength: 128 })
  const targets = catalog.find((tool) => tool.name === "lyrashield_list_targets").inputSchema
  Object.assign(targets.properties.limit, { minimum: 1, maximum: 100 })
  validateCatalog(catalog)
  Object.assign(scan.properties.idempotencyKey, { minLength: 0, maxLength: 256 })
  Object.assign(targets.properties.limit, { minimum: 0, maximum: 200 })
  validateCatalog(catalog)
})

test("stdio output limits and early stdin closure fail without hanging", async () => {
  await assert.rejects(
    probe("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)", {
      outputBytes: 4096,
    }),
    /stdout exceeded/
  )
  await assert.rejects(
    probe("process.stderr.write('x'.repeat(100000));setInterval(()=>{},1000)", {
      outputBytes: 4096,
    }),
    /stderr exceeded/
  )
  await assert.rejects(
    probe("process.stdin.destroy();process.exit(0)"),
    /exited before completion|stdin failed/
  )
})

test("metadata/archive reads cap byte streams and have independent timeouts", async () => {
  const oversized = async () => new Response("x".repeat(50))
  await assert.rejects(
    boundedFetch("https://registry.invalid", {
      maxBytes: 40,
      timeoutMs: 100,
      fetchImpl: oversized,
    }),
    /byte limit/
  )
  const noResponse = async () => new Promise(() => {})
  await assert.rejects(
    boundedFetch("https://registry.invalid", {
      maxBytes: 40,
      timeoutMs: 100,
      fetchImpl: noResponse,
    }),
    /timed out/
  )
  const stalledBody = async () => new Response(new ReadableStream({ start() {} }))
  await assert.rejects(
    boundedFetch("https://registry.invalid", {
      maxBytes: 40,
      timeoutMs: 100,
      fetchImpl: stalledBody,
    }),
    /timed out/
  )
})

test("SHA-512 integrity and staging archive path fail closed", () => {
  const archive = Buffer.from("verified")
  const hash = `sha512-${createHash("sha512").update(archive).digest("base64")}`
  verifyIntegrity(archive, hash)
  assert.throws(() => verifyIntegrity(Buffer.from("replaced"), hash), /integrity differs/)
  for (const filename of [
    "../escape.tgz",
    "/tmp/escape.tgz",
    "sub/package.tgz",
    "sub\\package.tgz",
    undefined,
  ])
    assert.throws(() => ownedArchivePath("/owned", filename), /outside staging/)
})

async function acquisitionFixture({
  mode = "healthy",
  integrity = true,
  filename = "packed.tgz",
  catalog = tools(),
} = {}) {
  const root = await temporary()
  await writeFile(
    path.join(root, ".mcp.kiro.json"),
    JSON.stringify({ mcpServers: { lyrashield: { args: ["-y", "@lyrashield/mcp@0.2.12"] } } })
  )
  const npmCommand = path.join(root, "fixture-npm.mjs")
  const calls = path.join(root, "calls.jsonl")
  await writeFile(
    npmCommand,
    `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
    const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,env:process.env})+'\\n');
    if(args[0]===${JSON.stringify(mode === "pack-hang" ? "pack" : mode === "install-hang" ? "install" : "none")}) {process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
    else if(args[0]==='pack') {fs.copyFileSync(args[1],path.join(process.cwd(),'packed.tgz'));process.stdout.write(JSON.stringify([{name:'@lyrashield/mcp',version:'0.2.12',filename:${JSON.stringify(filename)},files:['package.json','dist/stdio-transport.js','bin/lyrashield-mcp.mjs'].map(path=>({path}))}]))}
    else if(args[0]==='install') {const install=args[args.indexOf('--prefix')+1];const packageRoot=path.join(install,'node_modules/@lyrashield/mcp');fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
      fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'@lyrashield/mcp',version:'0.2.12',bin:{'lyrashield-mcp':'bin/lyrashield-mcp.mjs'}}));
      fs.writeFileSync(path.join(packageRoot,'bin/lyrashield-mcp.mjs'),${JSON.stringify(fixture({ catalog }))});}
    else process.exit(99);`,
    { mode: 0o700 }
  )
  const archive = Buffer.from("fixture verified archive")
  const hash = `sha512-${createHash("sha512").update(archive).digest("base64")}`
  const metadata = {
    name: "@lyrashield/mcp",
    version: "0.2.12",
    dist: {
      tarball: "https://registry.npmjs.org/@lyrashield/mcp/-/mcp-0.2.12.tgz",
      integrity: integrity ? hash : `sha512-${"A".repeat(86)}==`,
    },
  }
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(url)
    return new Response(requests.length === 1 ? JSON.stringify(metadata) : archive)
  }
  return {
    calls,
    requests,
    root,
    npmCommand,
    fetchImpl,
    limits: {
      ...LIMITS,
      processMs: mode === "pack-hang" || mode === "install-hang" ? 1000 : 5000,
      handshakeMs: 1500,
      terminateMs: 50,
    },
  }
}

test("acquisition installs and executes exactly the integrity-verified archive without npx", async () => {
  const config = await acquisitionFixture()
  assert.equal(await verifyPublishedMcp(config), "@lyrashield/mcp@0.2.12")
  const calls = (await readFile(config.calls, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(config.requests.length, 2)
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ["pack", "install"]
  )
  assert.ok(path.isAbsolute(calls[0].args[1]))
  assert.ok(path.isAbsolute(calls[1].args[1]))
  assert.equal(path.dirname(calls[0].args[1]), path.dirname(calls[1].args[1]))
  for (const call of calls) {
    assert.ok(call.args.includes("--ignore-scripts"))
    assert.ok(call.args.includes("--registry=https://registry.npmjs.org"))
    assert.equal(call.env.npm_config_ignore_scripts, "true")
    assert.equal(call.env.NPM_TOKEN, undefined)
  }
})

test("pinned .12 acquisition rejects E404 before executing npm", async () => {
  const config = await acquisitionFixture()
  config.fetchImpl = async (url) => {
    assert.equal(url, "https://registry.npmjs.org/@lyrashield%2fmcp/0.2.12")
    return new Response('{"error":"E404"}', { status: 404 })
  }
  await assert.rejects(verifyPublishedMcp(config), /pinned MCP package is unavailable: HTTP 404/)
  await assert.rejects(readFile(config.calls), /ENOENT/)
})

test("pinned .12 executable catalog rejects malformed schemas and missing retry fields", async () => {
  const invalid = tools()
  invalid[0].inputSchema = { type: "array" }
  await assert.rejects(
    verifyPublishedMcp(await acquisitionFixture({ catalog: invalid })),
    /schema is invalid/
  )
  for (const [name, property] of retryFields) {
    const catalog = tools()
    delete catalog.find((tool) => tool.name === name).inputSchema.properties[property]
    await assert.rejects(
      verifyPublishedMcp(await acquisitionFixture({ catalog })),
      /schema is incompatible/
    )
  }
})

test("pack/install hangs, integrity mismatch and archive traversal fail closed", async () => {
  for (const mode of ["pack-hang", "install-hang"]) {
    const config = await acquisitionFixture({ mode })
    await assert.rejects(verifyPublishedMcp(config), /timed out/)
  }
  const integrity = await acquisitionFixture({ integrity: false })
  await assert.rejects(verifyPublishedMcp(integrity), /integrity differs/)
  await assert.rejects(readFile(integrity.calls), /ENOENT/)
  const traversal = await acquisitionFixture({ filename: "../outside.tgz" })
  await assert.rejects(verifyPublishedMcp(traversal), /outside staging/)
})

test("real local npm pack/install suppress lifecycle scripts and preserve archive bytes", async () => {
  const directory = await temporary()
  const packageRoot = path.join(directory, "source")
  await mkdir(path.join(packageRoot, "bin"), { recursive: true })
  await mkdir(path.join(packageRoot, "dist"))
  const marker = path.join(directory, "lifecycle-ran")
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@lyrashield/mcp",
      version: "0.2.12",
      type: "module",
      bin: { "lyrashield-mcp": "bin/lyrashield-mcp.mjs" },
      scripts: { prepare: `touch ${marker}`, install: `touch ${marker}` },
    })
  )
  await writeFile(path.join(packageRoot, "bin/lyrashield-mcp.mjs"), fixture())
  await writeFile(path.join(packageRoot, "dist/stdio-transport.js"), "// fixture\n")
  const env = await isolatedEnvironment(directory)
  const { stdout } = await runOwnedProcess(
    "npm",
    ["pack", packageRoot, "--ignore-scripts", "--json", "--pack-destination", directory],
    { cwd: directory, env, timeoutMs: 5000, terminateMs: 50 }
  )
  const [packed] = JSON.parse(stdout)
  const archive = await readFile(path.join(directory, packed.filename))
  const config = await acquisitionFixture()
  config.npmCommand = "npm"
  config.limits.processMs = 5000
  const hash = `sha512-${createHash("sha512").update(archive).digest("base64")}`
  let requests = 0
  config.fetchImpl = async () =>
    new Response(
      ++requests === 1
        ? JSON.stringify({
            name: "@lyrashield/mcp",
            version: "0.2.12",
            dist: {
              tarball: "https://registry.npmjs.org/@lyrashield/mcp/-/mcp-0.2.12.tgz",
              integrity: hash,
            },
          })
        : archive
    )
  assert.equal(await verifyPublishedMcp(config), "@lyrashield/mcp@0.2.12")
  await assert.rejects(readFile(marker), /ENOENT/)
})
