import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const billingRequire = createRequire(
  new URL("../../../packages/billing/package.json", import.meta.url)
)
const razorpayRequire = createRequire(billingRequire.resolve("razorpay"))
const axiosRequire = createRequire(razorpayRequire.resolve("axios"))
const { http } = axiosRequire("follow-redirects")

test("cross-realm sensitive headers are removed on cross-origin redirects", async (t) => {
  let received
  const destination = createServer((request, response) => {
    received = request.headers
    response.end("ok")
  })
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve))
  t.after(() => destination.close())
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/` })
    response.end()
  })
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve))
  t.after(() => redirect.close())

  await new Promise((resolve, reject) => {
    http
      .get(
        `http://127.0.0.1:${redirect.address().port}/`,
        {
          headers: { "x-api-key": "synthetic-test-credential", "x-harmless": "retained" },
          sensitiveHeaders: runInNewContext('["x-api-key"]'),
        },
        (response) => {
          response.resume()
          response.on("end", resolve)
          response.on("error", reject)
        }
      )
      .on("error", reject)
  })

  assert.equal(received["x-api-key"], undefined)
  assert.equal(received["x-harmless"], "retained")
})
