import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { computeAuditHash, type AuditLogChainFields } from "./audit-hash"

function chain(workspaceId: string) {
  const first = {
    id: `${workspaceId}-1`,
    workspaceId,
    actorUserId: null,
    action: "test.created",
    resourceType: "test",
    resourceId: null,
    ipAddress: null,
    userAgent: null,
    metadata: { nested: { value: "original" } },
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
    prevHash: null,
    hash: "",
  } satisfies AuditLogChainFields & { prevHash: null; hash: string }
  first.hash = computeAuditHash(first, null)
  const second = {
    ...first,
    id: `${workspaceId}-2`,
    metadata: structuredClone(first.metadata),
    prevHash: first.hash,
  }
  second.hash = computeAuditHash(second, first.hash)
  return [first, second]
}

function verify(entries: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-audit-export-"))
  try {
    const file = join(directory, "audit.json")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated generated test fixture
    writeFileSync(file, JSON.stringify(entries))
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../scripts/verify-audit-chain-file.ts", import.meta.url)),
        file,
      ],
      { encoding: "utf8", cwd: fileURLToPath(new URL("../", import.meta.url)) }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("restored audit export verification", () => {
  it("verifies independent workspace chains from one restore export", () => {
    const result = verify([...chain("ws-1"), ...chain("ws-2")])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Verified 4 restored audit log entries")
  })

  it("still rejects tampered entries in a later workspace", () => {
    const entries = [...chain("ws-1"), ...chain("ws-2")]
    entries[3]!.metadata.nested.value = "tampered"
    expect(verify(entries).stderr).toContain("workspace 2, entry 2, content hash mismatch")
  })

  it("identifies a misordered chain without exposing audit identifiers", () => {
    const entries = chain("ws-1")
    const result = verify([entries[1], entries[0]])
    expect(result.stderr).toContain("workspace 1, entry 1, predecessor mismatch")
    expect(result.stderr).not.toContain("ws-1-1")
  })

  it("still rejects missing predecessors and cross-workspace links", () => {
    const first = chain("ws-1")
    const second = chain("ws-2")
    expect(verify([...first, second[1]]).stderr).toContain(
      "Restored audit chain verification failed"
    )
    second[1]!.prevHash = first[1]!.hash
    second[1]!.hash = computeAuditHash(second[1]!, first[1]!.hash)
    expect(verify([...first, ...second]).stderr).toContain(
      "Restored audit chain verification failed"
    )
  })
})
