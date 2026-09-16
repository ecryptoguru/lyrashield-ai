import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { test } from "node:test"

const script = ".github/scripts/verify-billing-deployment-config.mjs"
const catalog = {
  starter_monthly: "plan",
  starter_annual: "plan",
  pro_monthly: "plan",
  pro_annual: "plan",
  launch_assurance_monthly: "plan",
  launch_assurance_annual: "plan",
}
const polarCatalog = { ...catalog, pack_100: "product", pack_250: "product", pack_500: "product" }

const baseEnv = {
  ...process.env,
  POLAR_ENVIRONMENT: "production",
  POLAR_ACCESS_TOKEN: "polar_oat_valid",
  POLAR_WEBHOOK_SECRET: "secret",
  POLAR_ORG_ID: "org",
  POLAR_PRODUCT_IDS: JSON.stringify(polarCatalog),
  POLAR_LOCAL_PRODUCT_IDS: JSON.stringify({ local: "product" }),
  RAZORPAY_KEY_ID: "rzp_live_valid",
  RAZORPAY_KEY_SECRET: "secret",
  RAZORPAY_WEBHOOK_SECRET: "secret",
  RAZORPAY_PLAN_IDS: JSON.stringify(catalog),
  POLAR_BILLING_ADMISSION: "public",
  RAZORPAY_BILLING_ADMISSION: "public",
  BILLING_CANARY_WORKSPACE_IDS: "",
  CLOUDFLARE_ORIGIN_MTLS: "off",
  CLOUDFLARE_AOP_CERT_SHA256: "",
}

const run = (env = {}) =>
  execFileSync("node", [script], {
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })

const fails = (env, message) => {
  assert.throws(
    () => run(env),
    (error) => {
      assert.match(String(error.stderr), new RegExp(message))
      return true
    }
  )
}

test("accepts joint public billing admission with an empty allowlist", () => {
  assert.match(run(), /configuration is valid/)
})

test("accepts canary admission only with a valid allowlist", () => {
  assert.match(
    run({
      POLAR_BILLING_ADMISSION: "canary",
      RAZORPAY_BILLING_ADMISSION: "canary",
      BILLING_CANARY_WORKSPACE_IDS: "workspace_one,workspace-two",
    }),
    /configuration is valid/
  )
})

test("rejects split provider admission and invalid canary state", () => {
  fails({ RAZORPAY_BILLING_ADMISSION: "canary" }, "move jointly")
  fails(
    { POLAR_BILLING_ADMISSION: "canary", RAZORPAY_BILLING_ADMISSION: "canary" },
    "Canary admission requires valid workspace IDs"
  )
  fails({ BILLING_CANARY_WORKSPACE_IDS: "workspace_one" }, "Only canary admission")
})

test("rejects non-production providers and missing billing catalog keys", () => {
  fails({ POLAR_ENVIRONMENT: "sandbox" }, "POLAR_ENVIRONMENT=production")
  fails({ POLAR_ACCESS_TOKEN: "polar_pat_bad" }, "Organization Access Token")
  fails({ RAZORPAY_KEY_ID: "rzp_test_bad" }, "Razorpay live key")
  fails({ POLAR_PRODUCT_IDS: JSON.stringify(catalog) }, "POLAR_PRODUCT_IDS is missing pack_100")
})

test("rejects malformed admission and mTLS inputs without printing secrets", () => {
  fails({ POLAR_BILLING_ADMISSION: "on", RAZORPAY_BILLING_ADMISSION: "on" }, "mode is invalid")
  fails({ BILLING_CANARY_WORKSPACE_IDS: undefined }, "BILLING_CANARY_WORKSPACE_IDS must be set")
  fails(
    { CLOUDFLARE_ORIGIN_MTLS: "required", CLOUDFLARE_AOP_CERT_SHA256: "bad" },
    "certificate fingerprint"
  )
})
