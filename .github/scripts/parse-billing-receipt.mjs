// Accept only the receipt contract. Never interpolate dispatch JSON into shell code.
const booleanFields = [
  "resolve_razorpay_subscription_charge",
  "resolve_razorpay_subscription_cancellation",
  "resolve_polar_subscription_purchase",
  "resolve_polar_subscription_cancellation",
]
const stringFields = [
  "provider",
  "event_id",
  "workspace_id",
  "kind",
  "phase",
  "object_id",
  "plan",
  "interval",
  "status",
  "minutes",
  "remaining_minutes",
  "commission_count",
  "commission_status",
  "audit_action",
  "audit_resource_id",
  "audit_count",
]
const receipt = JSON.parse(process.env.RECEIPT_JSON || "{}")
if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
  throw new Error("Receipt must be a JSON object")
}
for (const [key, value] of Object.entries(receipt)) {
  if (booleanFields.includes(key)) {
    if (typeof value !== "boolean") throw new Error(`Invalid boolean receipt field: ${key}`)
  } else if (stringFields.includes(key)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.:/-]{0,191}$/.test(value)) {
      throw new Error(`Invalid receipt field: ${key}`)
    }
  } else {
    throw new Error(`Unknown receipt field: ${key}`)
  }
}
for (const key of [...stringFields, ...booleanFields]) {
  const fallback = booleanFields.includes(key) ? false : key === "phase" ? "purchase" : ""
  console.log(`BILLING_RECEIPT_${key.toUpperCase()}=${receipt[key] ?? fallback}`)
}
