// Disposable review stack only. The positive read uses the public example domain.
import assert from "node:assert/strict"
import { request } from "node:http"
import { writeFile } from "node:fs/promises"
import { mintRelayGrant } from "../../../packages/security/src/relay-grant.ts"

const base = "http://127.0.0.1:34009"
const admin = "ls-fixture-egress-review-only"
const secret = "ls-fixture-relay-signing-review-only-20260930"
const scanId = "docker_egress_disposable_fixture"
const grant = mintRelayGrant(
  {
    v: 1,
    scanId,
    hosts: ["example.com"],
    methods: ["GET", "HEAD"],
    blockedPaths: ["/admin"],
    exp: Date.now() + 60_000,
    maxRequests: 8,
    maxBytes: 100_000,
    ratePerMinute: 20,
    perPathPerMinute: 10,
  },
  secret
)
const headers = { Authorization: `Bearer ${admin}`, "x-lyra-relay-grant": grant }
async function adminRequest(path, options = {}) {
  return fetch(base + path, { signal: AbortSignal.timeout(15_000), ...options })
}
function forward(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 34009,
        path: url,
        method,
        headers: { "x-lyra-relay-grant": grant },
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
        )
      }
    )
    req.on("error", reject)
    req.setTimeout(15_000, () => req.destroy(new Error("relay fixture timeout")))
    req.end()
  })
}

assert.equal((await adminRequest("/health")).status, 200)
assert.equal((await adminRequest(`/v1/audit/${scanId}`)).status, 401)
assert.equal(
  (await adminRequest(`/v1/register/${scanId}`, { method: "POST", headers })).status,
  200
)
const allowed = await forward("https://example.com/")
assert.equal(allowed.status, 200, allowed.body)
assert.match(allowed.body, /Example Domain/)
const hostDenied = await forward("http://out-of-scope.invalid/")
assert.equal(hostDenied.status, 403)
assert.match(hostDenied.body, /host_out_of_scope/)
const pathDenied = await forward("https://example.com/admin/fixture")
assert.equal(pathDenied.status, 403)
assert.match(pathDenied.body, /path_blocked/)
const methodDenied = await forward("https://example.com/", "DELETE")
assert.equal(methodDenied.status, 403)
assert.match(methodDenied.body, /method_not_allowed/)
const privateFetch = await adminRequest("/v1/fetch", {
  method: "POST",
  headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: "http://127.0.0.1/private", timeoutMs: 1000, maxBytes: 1000 }),
})
assert.equal((await privateFetch.json()).reason, "ssrf_blocked")
assert.equal((await adminRequest(`/v1/revoke/${scanId}`, { method: "POST", headers })).status, 200)
const revoked = await forward("https://example.com/")
assert.equal(revoked.status, 403)
assert.match(revoked.body, /revoked/)
const audit = await (await adminRequest(`/v1/audit/${scanId}`, { headers })).json()
const receipt = {
  passed: true,
  allowedStatus: allowed.status,
  hostDenied,
  pathDenied,
  methodDenied,
  revoked,
  audit,
}
await writeFile(
  "/tmp/ls-hardening-20260930/evidence/egress-probe.json",
  JSON.stringify(receipt, null, 2)
)
console.log(JSON.stringify(receipt, null, 2))
