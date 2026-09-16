const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}

if (process.env.POLAR_ENVIRONMENT !== "production") {
  fail(
    "azure-production requires POLAR_ENVIRONMENT=production; Sandbox belongs only in isolated staging."
  )
}

const required = [
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_ORG_ID",
  "POLAR_PRODUCT_IDS",
  "POLAR_LOCAL_PRODUCT_IDS",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_PLAN_IDS",
]
for (const name of required) {
  if (!process.env[name]) {
    fail(
      `${name} is required for declarative billing configuration. Purchase admission remains off, but provider webhook and reconciliation configuration must be complete.`
    )
  }
}

if (
  !process.env.POLAR_ACCESS_TOKEN.startsWith("polar_oat_") ||
  process.env.POLAR_ACCESS_TOKEN.length === "polar_oat_".length
) {
  fail(
    "azure-production requires a Polar Organization Access Token; replace the protected POLAR_ACCESS_TOKEN secret."
  )
}
if (!process.env.RAZORPAY_KEY_ID.startsWith("rzp_live_")) {
  fail(
    "azure-production requires a Razorpay live key ID; Test Mode belongs only in isolated staging."
  )
}

const readJsonObject = (name) => {
  try {
    const value = JSON.parse(process.env[name])
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      Object.keys(value).length > 0
    ) {
      return value
    }
  } catch {}
  fail(`${name} must be a non-empty JSON object`)
}

for (const name of ["POLAR_PRODUCT_IDS", "POLAR_LOCAL_PRODUCT_IDS", "RAZORPAY_PLAN_IDS"]) {
  readJsonObject(name)
}
const requiredCatalogKeys = {
  POLAR_PRODUCT_IDS: [
    "starter_monthly",
    "starter_annual",
    "pro_monthly",
    "pro_annual",
    "launch_assurance_monthly",
    "launch_assurance_annual",
    "pack_100",
    "pack_250",
    "pack_500",
  ],
  // Razorpay packs are quote-signed payment links, not plans. Their prices and
  // identity come from MINUTE_PACK_MAP and webhook notes.
  RAZORPAY_PLAN_IDS: [
    "starter_monthly",
    "starter_annual",
    "pro_monthly",
    "pro_annual",
    "launch_assurance_monthly",
    "launch_assurance_annual",
  ],
}
for (const [name, keys] of Object.entries(requiredCatalogKeys)) {
  const value = readJsonObject(name)
  for (const key of keys) {
    if (!(key in value)) fail(`${name} is missing ${key}`)
  }
}

const modes = [process.env.POLAR_BILLING_ADMISSION, process.env.RAZORPAY_BILLING_ADMISSION]
if (!modes.every((mode) => ["off", "canary", "public"].includes(mode))) {
  fail("Cloud billing mode is invalid")
}
if (modes[0] !== modes[1]) {
  fail("Polar and Razorpay Cloud admissions must move jointly")
}
const allowlistValue = process.env.BILLING_CANARY_WORKSPACE_IDS
if (typeof allowlistValue !== "string") {
  fail("BILLING_CANARY_WORKSPACE_IDS must be set; use an empty value outside canary admission")
}
const allowlist = allowlistValue.split(",").filter(Boolean)
if (
  modes[0] === "canary" &&
  (!allowlist.length || !allowlist.every((id) => /^[A-Za-z0-9_-]{1,191}$/.test(id)))
) {
  fail("Canary admission requires valid workspace IDs")
}
if (modes[0] !== "canary" && allowlist.length) {
  fail("Only canary admission may set a workspace allowlist")
}
if (
  process.env.CLOUDFLARE_ORIGIN_MTLS === "required" &&
  !/^[a-fA-F0-9]{64}$/.test(process.env.CLOUDFLARE_AOP_CERT_SHA256)
) {
  fail("Required Cloudflare origin mTLS needs a certificate fingerprint")
}

console.log("Billing provider and protected admission configuration is valid.")
