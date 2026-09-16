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
const provider = (process.env.MYRA_CALENDAR_PROVIDER ?? "").trim()

if (provider !== "mock" && provider !== "google") {
  fail(
    `MYRA_CALENDAR_PROVIDER must be "mock" or "google" — got "${provider || "(empty)"}". ` +
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

if (writesEnabled) {
  if (provider !== "google") {
    fail(
      'MYRA_WRITES_ENABLED=1 requires MYRA_CALENDAR_PROVIDER="google" — ' +
        "production bookings must not run on the mock calendar."
    )
  }
  for (const name of ["MYRA_GOOGLE_CLIENT_ID", "MYRA_GOOGLE_CLIENT_SECRET"]) {
    if (!process.env[name]) {
      fail(`${name} is required when MYRA_WRITES_ENABLED=1 in production.`)
    }
  }
  if (!process.env.MYRA_GOOGLE_REFRESH_TOKEN && !process.env.MYRA_GOOGLE_TOKEN_JSON) {
    fail(
      "MYRA_GOOGLE_REFRESH_TOKEN or MYRA_GOOGLE_TOKEN_JSON is required when MYRA_WRITES_ENABLED=1 in production."
    )
  }
}

console.log("Myra deployment configuration is valid.")
