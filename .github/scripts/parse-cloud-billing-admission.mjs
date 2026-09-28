import { readFileSync } from "node:fs"

const fail = (message) => {
  console.error(`Invalid live Cloud billing admission: ${message}`)
  process.exit(1)
}

let entries
try {
  entries = JSON.parse(readFileSync(0, "utf8"))
} catch {
  fail("Azure revision environment is not valid JSON")
}
if (!Array.isArray(entries)) fail("Azure revision environment is missing")

const read = (name) => {
  const matches = entries.filter((entry) => entry?.name === name)
  if (matches.length !== 1 || typeof matches[0].value !== "string") {
    fail(`${name} must have exactly one literal value`)
  }
  return matches[0].value
}

const polar = read("POLAR_BILLING_ADMISSION")
const razorpay = read("RAZORPAY_BILLING_ADMISSION")
const allowlist = read("BILLING_CANARY_WORKSPACE_IDS")
if (!["off", "canary", "public"].includes(polar) || polar !== razorpay) {
  fail("Polar and Razorpay modes must be equal and valid")
}
if (polar === "canary") {
  if (!allowlist || !allowlist.split(",").every((id) => /^[A-Za-z0-9_-]{1,191}$/.test(id))) {
    fail("canary mode requires valid workspace IDs")
  }
} else if (allowlist) {
  fail("only canary mode may have a workspace allowlist")
}

console.log(`POLAR_BILLING_ADMISSION=${polar}`)
console.log(`RAZORPAY_BILLING_ADMISSION=${razorpay}`)
console.log(`BILLING_CANARY_WORKSPACE_IDS=${allowlist}`)
