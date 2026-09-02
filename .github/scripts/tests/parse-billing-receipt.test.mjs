import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { test } from "node:test"
const parse = (receipt) =>
  execFileSync(process.execPath, [".github/scripts/parse-billing-receipt.mjs"], {
    env: { ...process.env, RECEIPT_JSON: JSON.stringify(receipt) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
test("receipt fields preserve types, defaults and provider identity", () => {
  const result = parse({
    provider: "polar",
    event_id: "evt-123",
    resolve_polar_subscription_purchase: true,
    minutes: "100",
  })
  assert.match(result, /BILLING_RECEIPT_EVENT_ID=evt-123/)
  assert.match(result, /BILLING_RECEIPT_PHASE=purchase/)
  assert.match(result, /BILLING_RECEIPT_RESOLVE_POLAR_SUBSCRIPTION_PURCHASE=true/)
  assert.match(result, /BILLING_RECEIPT_RESOLVE_RAZORPAY_SUBSCRIPTION_CHARGE=false/)
})
test("receipt rejects unknown keys, malformed types and shell or line injection", () => {
  for (const value of [
    [],
    null,
    { provider: "$(touch stolen)" },
    { event_id: "ok\nBAD=value" },
    { source_sha: "override" },
    { resolve_polar_subscription_purchase: "false" },
    { minutes: 100 },
  ]) {
    assert.throws(() => parse(value))
  }
})
