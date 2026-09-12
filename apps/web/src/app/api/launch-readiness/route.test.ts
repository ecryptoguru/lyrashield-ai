import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getGateReadinessTargets: vi.fn(),
  groupBy: vi.fn().mockResolvedValue([]),
}))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: (_workspaceId: string, run: (tx: unknown) => unknown) =>
    run({ finding: { groupBy: mocks.groupBy } }),
}))
vi.mock("@/lib/launch-readiness-server", () => ({
  getGateReadinessTargets: mocks.getGateReadinessTargets,
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { role: "OWNER", member: {} },
  }),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { finding: { view: "finding.view" } },
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from "./route"

const COMMIT_A = "a".repeat(40)
const COMMIT_B = "b".repeat(40)
const DIGEST = `sha256:${"c".repeat(64)}`

const READY_TARGET = {
  targetId: "target-1",
  targetName: "API",
  state: "READY" as const,
  historicalState: "READY" as const,
  applicable: true,
  blockingFindings: 0,
  reasons: [] as { code: string; message: string }[],
  identity: { kind: "COMMIT" as const, value: COMMIT_A },
  assessedIdentity: { kind: "COMMIT" as const, value: COMMIT_A },
}

function request(query: string) {
  return new Request(`http://localhost/api/launch-readiness?${query}`)
}

describe("GET /api/launch-readiness — release check contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.groupBy.mockResolvedValue([])
    mocks.getGateReadinessTargets.mockResolvedValue([READY_TARGET])
  })

  it("returns no releaseCheck for a plain informational read", async () => {
    const response = await GET(request("workspaceId=ws-1"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.releaseCheck).toBeNull()
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledWith("ws-1", undefined, {
      expectedCommit: undefined,
      expectedArtifactDigest: undefined,
    })
  })

  it("reports a matching commit for a target-scoped check", async () => {
    const response = await GET(request(`workspaceId=ws-1&targetId=target-1&commit=${COMMIT_A}`))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledWith("ws-1", "target-1", {
      expectedCommit: COMMIT_A,
      expectedArtifactDigest: undefined,
    })
    expect(body.data.releaseCheck).toMatchObject({
      match: "match",
      targetId: "target-1",
      assessed: { kind: "COMMIT", value: COMMIT_A },
    })
  })

  it("normalizes an uppercase commit before evaluating applicability", async () => {
    const uppercaseCommit = "A".repeat(40)

    const response = await GET(
      request(`workspaceId=ws-1&targetId=target-1&commit=${uppercaseCommit}`)
    )

    expect(response.status).toBe(200)
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledWith("ws-1", "target-1", {
      expectedCommit: COMMIT_A,
      expectedArtifactDigest: undefined,
    })
    const body = await response.json()
    expect(body.data.releaseCheck).toMatchObject({
      match: "match",
      requested: { kind: "COMMIT", value: COMMIT_A },
      applicable: true,
    })
    expect(body.data.releaseCheck.reasons).not.toContainEqual(
      expect.objectContaining({ code: "IDENTITY_MISMATCH" })
    )
  })

  it("auto-selects one authorized target before applying the release identity", async () => {
    const response = await GET(request(`workspaceId=ws-1&commit=${COMMIT_A}`))

    expect(response.status).toBe(200)
    expect(mocks.getGateReadinessTargets).toHaveBeenNthCalledWith(1, "ws-1")
    expect(mocks.getGateReadinessTargets).toHaveBeenNthCalledWith(2, "ws-1", "target-1", {
      expectedCommit: COMMIT_A,
      expectedArtifactDigest: undefined,
    })
    const body = await response.json()
    expect(body.data.releaseCheck).toMatchObject({ match: "match", targetId: "target-1" })
  })

  it("does not apply one release identity across multiple targets while target selection is pending", async () => {
    mocks.getGateReadinessTargets.mockResolvedValue([
      READY_TARGET,
      { ...READY_TARGET, targetId: "target-2", targetName: "Worker" },
    ])

    const response = await GET(request(`workspaceId=ws-1&commit=${COMMIT_A}`))

    expect(response.status).toBe(200)
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledTimes(1)
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledWith("ws-1")
    const body = await response.json()
    expect(body.data.releaseCheck).toBeNull()
  })

  it("fails closed with 400 on simultaneous commit and artifactDigest", async () => {
    const response = await GET(
      request(`workspaceId=ws-1&targetId=target-1&commit=${COMMIT_A}&artifactDigest=${DIGEST}`)
    )
    expect(response.status).toBe(400)
    expect(mocks.getGateReadinessTargets).not.toHaveBeenCalled()
  })

  it("fails closed with 400 on a malformed commit", async () => {
    const response = await GET(request("workspaceId=ws-1&targetId=target-1&commit=abc123"))
    expect(response.status).toBe(400)
    expect(mocks.getGateReadinessTargets).not.toHaveBeenCalled()
  })

  it("fails closed with 400 on repeated identity params", async () => {
    const response = await GET(
      request(`workspaceId=ws-1&targetId=target-1&commit=${COMMIT_A}&commit=${COMMIT_B}`)
    )
    expect(response.status).toBe(400)
    expect(mocks.getGateReadinessTargets).not.toHaveBeenCalled()
  })

  it("passes a target-scoped artifact digest through to the gate read", async () => {
    const digestTarget = {
      ...READY_TARGET,
      assessedIdentity: { kind: "ARTIFACT_DIGEST" as const, value: DIGEST },
      identity: { kind: "ARTIFACT_DIGEST" as const, value: DIGEST },
    }
    mocks.getGateReadinessTargets.mockResolvedValue([digestTarget])

    const response = await GET(
      request(`workspaceId=ws-1&targetId=target-1&artifactDigest=${DIGEST}`)
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledWith("ws-1", "target-1", {
      expectedCommit: undefined,
      expectedArtifactDigest: DIGEST,
    })
    expect(body.data.releaseCheck.match).toBe("match")
  })

  it("normalizes an uppercase artifact digest before evaluating applicability", async () => {
    const uppercaseDigest = `sha256:${"C".repeat(64)}`
    const digestTarget = {
      ...READY_TARGET,
      assessedIdentity: { kind: "ARTIFACT_DIGEST" as const, value: DIGEST },
      identity: { kind: "ARTIFACT_DIGEST" as const, value: DIGEST },
    }
    mocks.getGateReadinessTargets.mockResolvedValue([digestTarget])

    const response = await GET(
      request(`workspaceId=ws-1&targetId=target-1&artifactDigest=${uppercaseDigest}`)
    )

    expect(response.status).toBe(200)
    expect(mocks.getGateReadinessTargets).toHaveBeenCalledWith("ws-1", "target-1", {
      expectedCommit: undefined,
      expectedArtifactDigest: DIGEST,
    })
    const body = await response.json()
    expect(body.data.releaseCheck).toMatchObject({
      match: "match",
      requested: { kind: "ARTIFACT_DIGEST", value: DIGEST },
      applicable: true,
    })
    expect(body.data.releaseCheck.reasons).not.toContainEqual(
      expect.objectContaining({ code: "IDENTITY_MISMATCH" })
    )
  })

  it("reports cannot-confirm for a targetId outside the workspace without leaking existence", async () => {
    mocks.getGateReadinessTargets.mockResolvedValue([])

    const response = await GET(request(`workspaceId=ws-1&targetId=other-target&commit=${COMMIT_A}`))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.releaseCheck.match).toBe("cannot_confirm")
    expect(body.data.releaseCheck.assessed).toBeNull()
  })
})
