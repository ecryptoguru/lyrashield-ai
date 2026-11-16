import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadSupervisorConfig } from "./config"

describe("unqualified supervisor entrypoint", () => {
  it("refuses to open even if an operator supplies the open flag", () => {
    expect(() => loadSupervisorConfig({ LYRASHIELD_RUNTIME_ADMISSION: "open" })).toThrow(
      /held until broker and journal qualification/
    )
  })

  it("fails startup if configured protected authority is incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "lyrashield-supervisor-"))
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          LYRASHIELD_SUPERVISOR_JOURNAL_PATH: join(directory, "journal"),
          LYRASHIELD_SUPERVISOR_SIGNING_SECRET: "s".repeat(40),
          LYRASHIELD_SUPERVISOR_INSTANCE_ID: "supervisor-test",
          LYRASHIELD_SUPERVISOR_CONTROL_TOKEN: "c".repeat(40),
          LYRASHIELD_PROVIDER_GATEWAY_URL: "http://127.0.0.1:1",
          LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN: "g".repeat(40),
          LYRASHIELD_SUPERVISOR_CGROUP_ROOT: "/sys/fs/cgroup/lyrashield",
          LYRASHIELD_SUPERVISOR_SOCKET_PATH: join(directory, "supervisor.sock"),
          LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: "postgresql://fixture@127.0.0.1:1/test",
          LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: "{}",
        },
        encoding: "utf8",
        timeout: 5_000,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("Protected supervisor authority configuration is unavailable")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
