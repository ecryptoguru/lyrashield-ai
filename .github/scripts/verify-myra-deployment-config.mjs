/**
 * Myra production fail-closed deployment check (Deep Review v18 item 1.4).
 *
 * The container app env assembly must never silently default the calendar to
 * the mock adapter and the test-only fault switches must never reach
 * production. This script runs before `az containerapp update`; any violation
 * exits 1 and stops the deploy.
 */

const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}

const writesEnabled = process.env.MYRA_WRITES_ENABLED === "1"
const publicBookingEnabled = process.env.MYRA_PUBLIC_BOOKING_ENABLED === "1"
const provider = (process.env.MYRA_CALENDAR_PROVIDER ?? "").trim()

if (process.env.MYRA_PUBLIC_ENABLED === "1" && !process.env.TURNSTILE_SECRET_KEY) {
  fail("Public Myra requires TURNSTILE_SECRET_KEY for anonymous session verification.")
}

if (process.env.MYRA_GENERATION_ENABLED === "1") {
  if (process.env.MYRA_PROVIDER !== "azure") fail("Myra generation requires the Azure provider.")
  if (process.env.MYRA_MODEL !== "gpt-6-luna")
    fail("Myra generation requires MYRA_MODEL=gpt-6-luna.")
  if (!process.env.MYRA_AZURE_OPENAI_ENDPOINT || !process.env.MYRA_AZURE_OPENAI_API_KEY) {
    fail("Myra generation requires its Azure endpoint and credential.")
  }
}

// An unset provider is valid while no booking path is enabled: no booking can
// execute, so nothing needs a calendar adapter. Writes-on or public-booking-on
// still requires "google" below.
if (!provider && !writesEnabled && !publicBookingEnabled) {
  console.log("calendar provider unset; writes are off")
} else if (provider && provider !== "mock" && provider !== "google") {
  fail(
    `MYRA_CALENDAR_PROVIDER must be "mock" or "google" — got "${provider}". ` +
      "The deploy no longer defaults it; set the repository variable explicitly."
  )
}

for (const name of [
  "MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT",
  "MYRA_MOCK_CALENDAR_PENDING_CONFERENCE",
  "MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT",
]) {
  if (process.env[name] === "1") {
    fail(`${name} is a test-only fault switch and must not be enabled for production deploys.`)
  }
}

const bookingEnabled = writesEnabled || publicBookingEnabled
const bookingReason = writesEnabled ? "MYRA_WRITES_ENABLED=1" : "MYRA_PUBLIC_BOOKING_ENABLED=1"

if (bookingEnabled) {
  if (provider !== "google") {
    fail(
      `${bookingReason} requires MYRA_CALENDAR_PROVIDER="google" — ` +
        "production bookings must not run on the mock calendar."
    )
  }
  for (const name of ["MYRA_GOOGLE_CLIENT_ID", "MYRA_GOOGLE_CLIENT_SECRET"]) {
    if (!process.env[name]) {
      fail(`${name} is required when ${bookingReason} in production.`)
    }
  }
  if (!process.env.MYRA_GOOGLE_REFRESH_TOKEN && !process.env.MYRA_GOOGLE_TOKEN_JSON) {
    fail(
      `MYRA_GOOGLE_REFRESH_TOKEN or MYRA_GOOGLE_TOKEN_JSON is required when ${bookingReason} in production.`
    )
  }
}

console.log("Myra deployment configuration is valid.")
