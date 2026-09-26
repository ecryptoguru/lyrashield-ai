import assert from "node:assert/strict"
import { test } from "node:test"
import { exactLocalOrigin, exactRemoteOrigin, pinRemoteOrigin, requestAllowed, parseOptions, run } from "./webmcp-runtime-check.mjs"

test("accepts only an exact numeric loopback origin", () => {
  assert.equal(exactLocalOrigin("http://127.0.0.1:4567"), "http://127.0.0.1:4567")
  for (const value of ["http://localhost:4567", "http://127.0.0.1:4567/path", "http://127.0.0.1:4567/?token=x", "http://user:pass@127.0.0.1:4567", "https://example.com"]) {
    assert.throws(() => exactLocalOrigin(value))
  }
})

test("active execution requires named tools and an input file", () => {
  assert.throws(() => parseOptions(["--origin", "http://127.0.0.1:4567", "--active-tool", "delete", "--output", "/tmp/receipt.json"]))
  assert.throws(() => parseOptions(["--fixture", "--active-tool", "echo", "--input-file", "/tmp/inputs.json", "--output", "/tmp/receipt.json"]))
})

test("owned staging requires an exact HTTPS origin and public pinned DNS", async () => {
  assert.equal(exactRemoteOrigin("https://staging.example.com"), "https://staging.example.com")
  for (const value of ["http://staging.example.com", "https://user:secret@staging.example.com", "https://staging.example.com/path", "https://127.0.0.1"]) {
    assert.throws(() => exactRemoteOrigin(value))
  }
  assert.throws(() => parseOptions(["--origin", "https://staging.example.com", "--output", "/tmp/receipt.json"]))
  assert.throws(() => parseOptions(["--origin", "https://staging.example.com", "--allow-origin", "https://other.example.com", "--owned-staging", "--output", "/tmp/receipt.json"]))
  assert.equal(await pinRemoteOrigin("https://staging.example.com", async () => ["8.8.8.8"]), "8.8.8.8")
  await assert.rejects(pinRemoteOrigin("https://staging.example.com", async () => ["8.8.8.8", "169.254.169.254"]))
})

test("request boundary rejects redirects and subresources outside declared origins", () => {
  const allowed = new Set(["https://staging.example.com"])
  assert.equal(requestAllowed("https://staging.example.com/app.js", allowed), true)
  assert.equal(requestAllowed("https://elsewhere.example.com/redirect", allowed), false)
  assert.equal(requestAllowed("http://staging.example.com/app.js", allowed), false)
  assert.equal(requestAllowed("https://staging.example.com.evil.invalid/app.js", allowed), false)
})

test("browser failure still returns an inconclusive receipt", async () => {
  const receipt = await run({ fixture: true }, async () => { throw new Error("browser unavailable") })
  assert.equal(receipt.browser.nativeApiAvailable, false)
  assert.equal(receipt.checks.every((item) => item.state === "INCONCLUSIVE"), true)
})

test("optional real Chrome fixture records native observations without inventing cancellation proof", { skip: !process.env.WEBMCP_CHROME }, async () => {
  const receipt = await run({ fixture: true, browser: process.env.WEBMCP_CHROME })
  assert.match(receipt.target.contentChecksum, /^[a-f0-9]{64}$/)
  assert.equal(receipt.checks.find((item) => item.id === "NATIVE_API")?.state, "PASS")
  assert.equal(receipt.checks.find((item) => item.id === "DISCOVERY")?.state, "PASS")
  assert.equal(receipt.checks.find((item) => item.id === "CROSS_ORIGIN")?.state, "PASS")
  assert.equal(receipt.checks.find((item) => item.id === "CONFIRMATION")?.state, "PASS")
  assert.equal(receipt.checks.find((item) => item.id === "CLEANUP")?.state, "PASS")
  if (receipt.browser.version.startsWith("152.")) {
    assert.equal(receipt.checks.find((item) => item.id === "CANCELLATION")?.state, "INCONCLUSIVE")
  }
})
