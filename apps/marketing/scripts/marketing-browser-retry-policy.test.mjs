import assert from "node:assert/strict"
import test from "node:test"
import { isKnownWranglerProxyFailure } from "./marketing-browser-retry-policy.mjs"

const wranglerProxyFailure = `
Error in ProxyController: Error inside ProxyWorker
    at ProxyController2.onProxyWorkerMessage (...)
    at async #handleLoopbackCustomFetchService (...)
cause: { name: 'Error', message: 'Network connection lost.' }
`

test("recognizes the known Wrangler ProxyWorker disconnect signature", () => {
  assert.equal(isKnownWranglerProxyFailure([wranglerProxyFailure]), true)
})

test("does not retry an empty Wrangler error without the network-loss cause", () => {
  assert.equal(
    isKnownWranglerProxyFailure(["Error in ProxyController: Error inside ProxyWorker\n✘ [ERROR]"]),
    false
  )
})

test("does not combine markers from separate log files", () => {
  assert.equal(
    isKnownWranglerProxyFailure([
      "Error in ProxyController: Error inside ProxyWorker",
      "message: 'Network connection lost.' ProxyController2.onProxyWorkerMessage #handleLoopbackCustomFetchService",
    ]),
    false
  )
})

test("does not retry ordinary browser connection failures", () => {
  assert.equal(isKnownWranglerProxyFailure(["net::ERR_CONNECTION_REFUSED"]), false)
})
