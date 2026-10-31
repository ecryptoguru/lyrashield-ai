/* eslint-disable security/detect-non-literal-fs-filename -- Files stay inside the generated local fixture directory. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const workflow = readFileSync(".github/workflows/production-scan-readiness.yml", "utf8")
const scripts = workflow
  .split("        run: |\n")
  .slice(1)
  .map((section) => {
    const lines = section.split("\n")
    const end = lines.findIndex((line) => line !== "" && !line.startsWith("          "))
    return lines
      .slice(0, end < 0 ? undefined : end)
      .map((line) => line.slice(10))
      .join("\n")
  })
assert.equal(scripts.length, 2)
const ready = '{"status":"ready","checks":{"worker":true}}'
const notReady = '{"status":"not_ready","checks":{"worker":false}}'

async function run(script, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], { env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => (stdout += data))
    child.stderr.on("data", (data) => (stderr += data))
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

async function probe(t, replies) {
  const directory = mkdtempSync(path.join(tmpdir(), "readiness-probe-"))
  const outputPath = path.join(directory, "output")
  const summaryPath = path.join(directory, "summary")
  writeFileSync(outputPath, "")
  writeFileSync(summaryPath, "")
  let requests = 0
  const server = createServer((request, response) => {
    const reply = replies[Math.min(requests++, replies.length - 1)]
    if (reply.transportFailure) return request.socket.destroy()
    if (reply.timeout || reply.processTimeout) return
    response.writeHead(reply.status, reply.headers ?? {})
    response.end(reply.body)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  // Execute the actual workflow body against localhost with no retry wait.
  // Only the timeout cases shorten their respective production time limit.
  const script = scripts[0]
    .replace(
      "https://app.lyrashieldai.com/api/ready/scans",
      `http://127.0.0.1:${server.address().port}/api/ready/scans`
    )
    .replaceAll("--retry-delay 5", "--retry-delay 0")
    .replaceAll("time.sleep(5)", "time.sleep(0)")
    .replaceAll('"--max-time", "15"', `"--max-time", "${replies[0].timeout ? "0.1" : "15"}"`)
    .replaceAll("timeout=20", `timeout=${replies[0].processTimeout ? "0.1" : "20"}`)
  const result = await run(script, { GITHUB_OUTPUT: outputPath })
  const output = readFileSync(outputPath, "utf8")
  const fields = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=")
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
  const report = await run(scripts[1], {
    GITHUB_STEP_SUMMARY: summaryPath,
    PROBE_STATUS: fields.http_status,
    PROBE_BODY: fields.body,
    PROBE_DIAGNOSTIC: fields.diagnostic,
  })
  assert.equal(report.status, 0, report.stderr)
  return { ...result, requests, output, fields, summary: readFileSync(summaryPath, "utf8") }
}

test("503 followed by 200 succeeds using only the final response", async (t) => {
  const result = await probe(t, [
    { status: 503, body: notReady },
    { status: 200, body: ready },
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.requests, 2)
  assert.equal(result.fields.http_status, "200")
  assert.doesNotMatch(result.fields.body, /not_ready/)
})

test("persistent 503 fails with the final status and response visible", async (t) => {
  const result = await probe(t, [{ status: 503, body: notReady }])
  assert.notEqual(result.status, 0)
  assert.equal(result.requests, 3)
  assert.equal(result.fields.http_status, "503")
  assert.match(result.summary, /503/)
  assert.match(result.summary, /not_ready/)
  assert.match(result.fields.diagnostic, /HTTP 503/)
})

for (const status of [400, 503]) {
  test(`HTTP ${status} cannot succeed with a ready-looking body`, async (t) => {
    const result = await probe(t, [{ status, body: ready }])
    assert.notEqual(result.status, 0)
    assert.equal(result.fields.http_status, String(status))
  })
}

test("a ready-looking earlier error cannot override the final failed contract", async (t) => {
  const result = await probe(t, [
    { status: 503, body: ready },
    { status: 200, body: notReady },
  ])
  assert.notEqual(result.status, 0)
  assert.equal(result.fields.http_status, "200")
  assert.match(result.fields.body, /not_ready/)
})

test("transport failure remains failed with an explicit diagnostic", async (t) => {
  const result = await probe(t, [{ transportFailure: true }])
  assert.notEqual(result.status, 0)
  assert.equal(result.requests, 3)
  assert.equal(result.fields.http_status, "000")
  assert.match(result.fields.diagnostic, /transport|curl/i)
})

test("a stalled response fails within the curl time bound", async (t) => {
  const result = await probe(t, [{ timeout: true }])
  assert.notEqual(result.status, 0)
  assert.equal(result.fields.http_status, "000")
  assert.match(result.fields.diagnostic, /timed out/i)
})

test("the process deadline still publishes a bounded transport diagnostic", async (t) => {
  const result = await probe(t, [{ processTimeout: true }])
  assert.notEqual(result.status, 0)
  assert.equal(result.fields.http_status, "000")
  assert.match(result.fields.diagnostic, /process timed out/i)
})

for (const [name, body] of [
  ["empty", ""],
  ["invalid", "not json"],
  ["deeply nested", "[".repeat(2000) + "]".repeat(2000)],
  ["wrong contract", '{"status":"ready","checks":{"worker":1}}'],
]) {
  test(`${name} reply fails with bounded diagnostics`, async (t) => {
    const result = await probe(t, [{ status: 200, body }])
    assert.notEqual(result.status, 0)
    assert.equal(result.fields.http_status, "200")
    assert.ok(result.fields.diagnostic.length > 0)
    assert.ok(result.output.length < 20000)
  })
}

test("multiline valid JSON preserves the readiness contract", async (t) => {
  const result = await probe(t, [{ status: 200, body: JSON.stringify(JSON.parse(ready), null, 2) }])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.requests, 1)
  assert.equal(result.output.trim().split("\n").length, 3)
})

test("untrusted multiline and markup replies cannot inject outputs, commands or summary HTML", async (t) => {
  const body =
    "failure\nowned=injected\r\n::error::forged\u001b[31m\n</pre><script>alert(1)</script>\n```"
  const result = await probe(t, [{ status: 503, body }])
  assert.notEqual(result.status, 0)
  assert.deepEqual(Object.keys(result.fields).sort(), ["body", "diagnostic", "http_status"])
  assert.doesNotMatch(result.stdout + result.stderr, /::error::forged/)
  assert.doesNotMatch(result.summary, /<script>|\u001b|\nowned=|\n::error::/)
  assert.match(result.summary, /&lt;script&gt;/)
})

for (const contentLength of [false, true]) {
  test(`oversized reply is bounded and fails (content-length ${contentLength})`, async (t) => {
    const body = ready + " ".repeat(500000)
    const result = await probe(t, [
      {
        status: 200,
        body,
        headers: contentLength ? { "content-length": Buffer.byteLength(body) } : {},
      },
    ])
    assert.notEqual(result.status, 0)
    assert.equal(result.fields.http_status, "200")
    assert.ok(result.output.length < 20000)
    assert.ok(result.summary.length < 20000)
    assert.match(result.fields.diagnostic, /size|large|curl/i)
  })
}

test("readiness scheduling, visibility and maintenance-aware recovery guidance are preserved", () => {
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/)
  assert.match(workflow, /if: failure\(\)/)
  assert.doesNotMatch(workflow, /actions\/checkout@|secrets\./)
  assert.match(workflow, /owned maintenance/)
  assert.match(workflow, /approved.*runbook|runbook.*approved/)
  assert.doesNotMatch(workflow, /Restart lyrashield-worker/)
})
