import { describe, expect, it } from "vitest"
import { authTestMailConfigAllowed, isSafeDisposableDatabaseUrl } from "./auth-test-mail"

const local = {
  directory: "/tmp/lyrashield-auth-mail-fixture",
  ownedDirectory: "/tmp/lyrashield-auth-mail-fixture",
  nodeEnv: "development",
  authUrl: "http://127.0.0.1:3102",
  appUrl: "http://127.0.0.1:3102",
  databaseUrl: "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test",
  disposable: "1",
}

describe("auth reset mail fixture configuration", () => {
  it("keeps ordinary production mail configuration valid when capture is off", () => {
    expect(authTestMailConfigAllowed({ ...local, directory: "", nodeEnv: "production" })).toBe(true)
  })

  it.each(["development", "test"])("permits explicit disposable %s capture", (nodeEnv) => {
    expect(authTestMailConfigAllowed({ ...local, nodeEnv })).toBe(true)
  })

  it.each([
    "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test",
    "postgresql://fixture:fixture@localhost:5432/lyrashield_test?schema=public",
    "postgresql://fixture:fixture@[::1]:5432/lyrashield_test?schema=public",
  ])("accepts a named loopback database URL: %s", (databaseUrl) => {
    expect(isSafeDisposableDatabaseUrl(databaseUrl)).toBe(true)
  })

  it.each([
    "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&host=remote.example",
    "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&hostaddr=198.51.100.8",
    "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&%68ost=remote.example",
    "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&schema=private",
    "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public#",
  ])("rejects query or fragment overrides in a loopback database URL", (databaseUrl) => {
    expect(isSafeDisposableDatabaseUrl(databaseUrl)).toBe(false)
  })

  it.each([
    { nodeEnv: "production" },
    { nodeEnv: "" },
    { disposable: "" },
    { ownedDirectory: "/tmp/lyrashield-auth-mail-caller-owned" },
    { brevoApiKey: "synthetic-provider-key" },
    { authUrl: "https://app.example.test" },
    { appUrl: "http://127.0.0.1:3100" },
    { authUrl: "http://localhost:3102" },
    { authUrl: "http://127.0.0.1.evil.example:3102" },
    { authUrl: "http://user@127.0.0.1:3102" },
    { authUrl: "http://127.0.0.1:3102/path" },
    { authUrl: "http://127.0.0.1:3102/?query=1" },
    { databaseUrl: "postgresql://fixture:fixture@remote.example/lyrashield_test" },
    { databaseUrl: "http://127.0.0.1/lyrashield_test" },
    { databaseUrl: "postgresql://fixture:fixture@127.0.0.1/production" },
    {
      databaseUrl:
        "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&host=remote.example",
    },
    {
      databaseUrl:
        "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&hostaddr=198.51.100.8",
    },
    {
      databaseUrl:
        "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&%68ost=remote.example",
    },
    {
      databaseUrl:
        "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public&schema=private",
    },
    {
      databaseUrl: "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?schema=public#",
    },
    {
      databaseSystemUrl:
        "postgresql://fixture:fixture@127.0.0.1:5432/lyrashield_test?host=remote.example",
    },
  ])("rejects an unsafe capture configuration: %j", (override) => {
    expect(authTestMailConfigAllowed({ ...local, ...override })).toBe(false)
  })
})
