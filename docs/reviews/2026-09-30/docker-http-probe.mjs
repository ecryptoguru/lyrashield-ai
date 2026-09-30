// Disposable review stack only. Never point this fixture at a shared service.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const base = process.env.DOCKER_HTTP_ORIGIN ?? "http://localhost:33009"
assert.ok(
  ["http://localhost:33009", "http://localhost:33012"].includes(base),
  "Disposable origins only"
)
const output = process.env.DOCKER_HTTP_OUTPUT ?? "/tmp/ls-hardening-20260930/evidence"
assert.ok(output.startsWith("/tmp/ls-hardening-20260930/evidence"), "Disposable artifact path only")
const expectedTerminal = process.env.DOCKER_HTTP_EXPECT_TERMINAL ?? "COMPLETED"
assert.ok(["COMPLETED", "FAILED"].includes(expectedTerminal))
const cookieJar = new Map()
const steps = []
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Origin: base,
      Cookie: [...cookieJar].map(([key, value]) => `${key}=${value}`).join("; "),
      ...options.headers,
    },
  })
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";")
    const split = pair.indexOf("=")
    cookieJar.set(pair.slice(0, split), pair.slice(split + 1))
  }
  steps.push({ path, status: response.status, location: response.headers.get("location") })
  return response
}

await mkdir(output, { recursive: true })
assert.equal((await request("/api/health")).status, 200)
const legacyLogin = await request("/login")
assert.equal(legacyLogin.status, 307)
assert.equal(legacyLogin.headers.get("location"), "/sign-in")
assert.equal((await request("/sign-in")).status, 200)
const unauthenticated = await request("/dashboard")
assert.ok([302, 303, 307, 308].includes(unauthenticated.status))
assert.match(unauthenticated.headers.get("location") ?? "", /sign-in/)

const account = {
  email: `docker-http-${Date.now()}@example.invalid`,
  password: "ls-fixture-password-review-only-20260930!",
  name: "Disposable Docker HTTP Fixture",
}
const signup = await request("/api/auth/sign-up/email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(account),
})
assert.equal(signup.status, 200, await signup.clone().text())
const signupBody = await signup.json()
const session = await request("/api/auth/get-session")
assert.equal(session.status, 200)
assert.equal((await session.json()).user.id, signupBody.user.id)
const dashboard = await request("/dashboard")
assert.ok([200, 302, 303, 307, 308].includes(dashboard.status))
assert.doesNotMatch(dashboard.headers.get("location") ?? "", /sign-in/)
const signout = await request("/api/auth/sign-out", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
})
assert.equal(signout.status, 200)
assert.equal(await (await request("/api/auth/get-session")).json(), null)
const signin = await request("/api/auth/sign-in/email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: account.email, password: account.password }),
})
assert.equal(signin.status, 200, await signin.clone().text())
assert.equal((await (await request("/api/auth/get-session")).json()).user.id, signupBody.user.id)

const workspaceResponse = await request("/api/workspaces", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `Disposable Docker ${Date.now()}`, mode: "VIBE" }),
})
assert.equal(workspaceResponse.status, 200, await workspaceResponse.clone().text())
const workspaceId = (await workspaceResponse.json()).data.id
const privateTarget = await request("/api/targets", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    workspaceId,
    type: "WEB_APP",
    name: "Private denial fixture",
    url: "http://127.0.0.1/private",
    ownershipAttested: true,
  }),
})
assert.equal(privateTarget.status, 400)
assert.equal((await privateTarget.json()).error.code, "SSRF_BLOCKED")
const targetResponse = await request("/api/targets", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    workspaceId,
    type: "WEB_APP",
    name: "Passive owned marketing fixture",
    url: "https://lyrashieldai.com/",
    ownershipAttested: true,
  }),
})
assert.equal(targetResponse.status, 200, await targetResponse.clone().text())
const targetId = (await targetResponse.json()).data.id
const createScanOptions = {
  method: "POST",
  headers: { "Content-Type": "application/json", "idempotency-key": `docker-fixture-${targetId}` },
  body: JSON.stringify({ workspaceId, targetId, mode: "SAFE", goal: "TEST_APP" }),
}
const admitted = await request("/api/scans", createScanOptions)
assert.equal(admitted.status, 201, await admitted.clone().text())
const scanId = (await admitted.json()).data.id
const repeated = await request("/api/scans", createScanOptions)
assert.equal(repeated.status, 200, await repeated.clone().text())
assert.equal((await repeated.json()).data.id, scanId)
console.log(JSON.stringify({ admittedScanId: scanId, workspaceId }))
let terminalScan
for (let attempt = 0; attempt < 90; attempt++) {
  const scan = await request(`/api/scans/${scanId}?workspaceId=${workspaceId}`)
  assert.equal(scan.status, 200, await scan.clone().text())
  const body = (await scan.json()).data
  if (["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(body.status)) {
    terminalScan = body
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
assert(terminalScan, "Passive deterministic fixture must reach a terminal state")
assert.equal(terminalScan.status, expectedTerminal, JSON.stringify(terminalScan))
assert.equal(terminalScan.mode, "SAFE")

for (const [format, width, height] of [
  ["wide", 1200, 630],
  ["square", 1080, 1080],
  ["portrait", 1080, 1350],
]) {
  for (const variant of ["grade", "fixes"]) {
    const image = await request(
      `/api/og/score/next-og-disposable-fixture?format=${format}&variant=${variant}`
    )
    assert.equal(image.status, 200, await image.clone().text())
    assert.match(image.headers.get("Content-Type") ?? "", /^image\/png/)
    assert.match(image.headers.get("Cache-Control") ?? "", /no-store/)
    const bytes = Buffer.from(await image.arrayBuffer())
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
    assert.equal(bytes.readUInt32BE(16), width)
    assert.equal(bytes.readUInt32BE(20), height)
    await writeFile(resolve(output, `score-${format}-${variant}.png`), bytes)
  }
}
assert.equal((await request("/api/og/score/disposable-card-that-does-not-exist")).status, 404)
assert.equal((await request("/api/og/lite-check/invalid-token")).status, 404)
await writeFile(
  resolve(output, "http-probe.json"),
  JSON.stringify(
    { fixtureUserId: signupBody.user.id, workspaceId, scanId, terminalScan, steps },
    null,
    2
  )
)
console.log(
  JSON.stringify(
    {
      passed: true,
      fixtureUserId: signupBody.user.id,
      workspaceId,
      scanId,
      terminalStatus: terminalScan.status,
      steps,
    },
    null,
    2
  )
)
