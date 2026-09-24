import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { test } from "node:test"

const script = ".github/scripts/verify-myra-deployment-config.mjs"

const baseEnv = {
  ...process.env,
  MYRA_WRITES_ENABLED: "0",
  MYRA_PUBLIC_BOOKING_ENABLED: "0",
  MYRA_DASHBOARD_ENABLED: "0",
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_GENERATION_ENABLED: "0",
  MYRA_PROVIDER: "mock",
  MYRA_MODEL: "",
  MYRA_AZURE_OPENAI_ENDPOINT: "",
  MYRA_AZURE_OPENAI_API_KEY: "",
  MYRA_CALENDAR_PROVIDER: "mock",
  MYRA_GOOGLE_CLIENT_ID: "",
  MYRA_GOOGLE_CLIENT_SECRET: "",
  MYRA_GOOGLE_REFRESH_TOKEN: "",
  MYRA_GOOGLE_TOKEN_JSON: "",
  MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT: "",
  MYRA_MOCK_CALENDAR_PENDING_CONFERENCE: "",
  MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT: "",
  TURNSTILE_SECRET_KEY: "",
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

const googleEnv = {
  MYRA_WRITES_ENABLED: "1",
  MYRA_CALENDAR_PROVIDER: "google",
  MYRA_GOOGLE_CLIENT_ID: "client-id",
  MYRA_GOOGLE_CLIENT_SECRET: "secret",
  MYRA_GOOGLE_REFRESH_TOKEN: "refresh",
}

test("accepts the google provider with complete credentials when writes are enabled", () => {
  assert.match(run(googleEnv), /Myra deployment configuration is valid/)
})

test("accepts the mock provider when writes are disabled", () => {
  assert.match(run(), /Myra deployment configuration is valid/)
})

test("allows all verified accounts without an email allowlist", () => {
  // An unset or blank allowlist is no longer meaningful: admission is the
  // verified email alone. A blank value must still validate.
  assert.match(run({ MYRA_DASHBOARD_ENABLED: "1" }), /valid/)
  assert.match(run({ ...googleEnv, MYRA_DASHBOARD_ENABLED: "1" }), /valid/)
})

test("requires Turnstile verification for public Myra", () => {
  fails({ MYRA_PUBLIC_ENABLED: "1" }, "TURNSTILE_SECRET_KEY")
  assert.match(
    run({ MYRA_PUBLIC_ENABLED: "1", TURNSTILE_SECRET_KEY: "configured-secret" }),
    /valid/
  )
})

test("requires one exact Azure Luna deployment before enabling generation", () => {
  const enabled = { MYRA_GENERATION_ENABLED: "1", MYRA_PROVIDER: "azure" }
  fails(enabled, "MYRA_MODEL")
  fails({ ...enabled, MYRA_MODEL: "gpt-5.6-luna" }, "MYRA_MODEL")
  fails({ ...enabled, MYRA_MODEL: "gpt-6-luna" }, "Azure endpoint and credential")
  assert.match(
    run({
      ...enabled,
      MYRA_MODEL: "gpt-6-luna",
      MYRA_AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      MYRA_AZURE_OPENAI_API_KEY: "secret",
    }),
    /valid/
  )
})

test("rejects writes enabled against the mock calendar provider", () => {
  fails({ ...googleEnv, MYRA_CALENDAR_PROVIDER: "mock" }, "MYRA_CALENDAR_PROVIDER")
})

test("rejects writes enabled with no provider value at all", () => {
  fails({ ...googleEnv, MYRA_CALENDAR_PROVIDER: "" }, "MYRA_CALENDAR_PROVIDER")
})

test("accepts an unset provider while writes are off", () => {
  assert.match(run({ MYRA_CALENDAR_PROVIDER: "" }), /calendar provider unset; writes are off/)
  assert.match(run({ MYRA_CALENDAR_PROVIDER: "" }), /Myra deployment configuration is valid/)
  assert.match(
    run({
      MYRA_DASHBOARD_ENABLED: "1",
      MYRA_CALENDAR_PROVIDER: "",
    }),
    /Myra deployment configuration is valid/
  )
})

test("rejects an unrecognized provider value even while writes are off", () => {
  fails({ MYRA_CALENDAR_PROVIDER: "caldav" }, "MYRA_CALENDAR_PROVIDER")
})

test("rejects writes enabled without usable Google credentials", () => {
  fails({ ...googleEnv, MYRA_GOOGLE_CLIENT_SECRET: "" }, "MYRA_GOOGLE_CLIENT_SECRET")
  fails(
    {
      ...googleEnv,
      MYRA_GOOGLE_REFRESH_TOKEN: "",
      MYRA_GOOGLE_TOKEN_JSON: "",
    },
    "MYRA_GOOGLE_REFRESH_TOKEN or MYRA_GOOGLE_TOKEN_JSON"
  )
})

test("applies the google calendar rule when only public booking is enabled", () => {
  const publicBookingEnv = {
    MYRA_PUBLIC_BOOKING_ENABLED: "1",
    MYRA_WRITES_ENABLED: "0",
  }
  fails({ ...publicBookingEnv, MYRA_CALENDAR_PROVIDER: "mock" }, "MYRA_CALENDAR_PROVIDER")
  fails({ ...publicBookingEnv, MYRA_CALENDAR_PROVIDER: "" }, "MYRA_CALENDAR_PROVIDER")
  fails(
    { ...publicBookingEnv, MYRA_CALENDAR_PROVIDER: "google", MYRA_GOOGLE_CLIENT_ID: "id" },
    "MYRA_GOOGLE_CLIENT_SECRET"
  )
  assert.match(
    run({
      ...publicBookingEnv,
      MYRA_CALENDAR_PROVIDER: "google",
      MYRA_GOOGLE_CLIENT_ID: "id",
      MYRA_GOOGLE_CLIENT_SECRET: "secret",
      MYRA_GOOGLE_TOKEN_JSON: "json",
    }),
    /Myra deployment configuration is valid/
  )
})

test("rejects enabled mock calendar fault switches", () => {
  fails(
    { ...googleEnv, MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT: "1" },
    "MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT"
  )
  fails(
    { ...googleEnv, MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT: "1" },
    "MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT"
  )
})
