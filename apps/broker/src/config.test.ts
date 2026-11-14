import { describe, expect, it } from "vitest"
import { loadBrokerConfig } from "./config"

const token = "b".repeat(40)
const database = "postgres://broker@localhost/lyrashield"

describe("broker installation", () => {
  it("refuses to start without a database URL or a strong control token", () => {
    expect(() => loadBrokerConfig({})).toThrow(/LYRASHIELD_SCAN_EXECUTION_DATABASE_URL/)
    expect(() => loadBrokerConfig({ LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: database })).toThrow(
      /LYRASHIELD_BROKER_CONTROL_TOKEN/
    )
    expect(() =>
      loadBrokerConfig({
        LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: database,
        LYRASHIELD_BROKER_CONTROL_TOKEN: "short",
      })
    ).toThrow(/at least 32/)
  })

  it("defaults to loopback with no receipt consumer", () => {
    expect(
      loadBrokerConfig({
        LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: database,
        LYRASHIELD_BROKER_CONTROL_TOKEN: token,
      })
    ).toEqual({
      connectionString: database,
      transport: { kind: "loopback", host: "127.0.0.1", port: 8080 },
      controlToken: token,
      admission: "closed",
      receiptAuthority: undefined,
    })
  })

  it("only permits loopback TCP addresses", () => {
    const base = {
      LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: database,
      LYRASHIELD_BROKER_CONTROL_TOKEN: token,
    }
    for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.com"]) {
      expect(() => loadBrokerConfig({ ...base, LYRASHIELD_BROKER_HOST: host })).toThrow()
    }
    for (const host of ["127.0.0.1", "::1"]) {
      expect(loadBrokerConfig({ ...base, LYRASHIELD_BROKER_HOST: host }).transport).toMatchObject({
        kind: "loopback",
        host,
      })
    }
    expect(
      loadBrokerConfig({ ...base, LYRASHIELD_BROKER_HOST: "localhost" }).transport
    ).toMatchObject({
      kind: "loopback",
      host: "127.0.0.1",
    })
  })

  it("installs the receipt consumer only from a complete protected source", () => {
    const base = {
      LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: database,
      LYRASHIELD_BROKER_CONTROL_TOKEN: token,
      LYRASHIELD_BROKER_SOCKET_PATH: "/run/lyrashield/broker.sock",
      LYRASHIELD_SUPERVISOR_SIGNING_SECRET: "s".repeat(40),
      LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET: "m".repeat(40),
      LYRASHIELD_SUPERVISOR_CONTROL_TOKEN: "c".repeat(40),
      LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify({
        streamId: "stream-1",
        authorityEpochId: "epoch-1",
        supervisorInstanceId: "supervisor-1",
        originalKeyHash: "a".repeat(64),
        wrapperKeyHash: "d".repeat(64),
        socketPath: "/run/lyrashield/supervisor.sock",
      }),
    }
    expect(loadBrokerConfig(base).receiptAuthority).toMatchObject({ streamId: "stream-1" })
    expect(() =>
      loadBrokerConfig({ ...base, LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: "{}" })
    ).toThrow(/Protected supervisor source/)
  })
})
