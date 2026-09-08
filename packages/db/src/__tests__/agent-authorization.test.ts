import { describe, expect, it } from "vitest"
import {
  CANONICAL_OPERATIONS,
  TOOL_OPERATION_MAP,
  checkDelegatedOperationAuthorization,
} from "../agent-authorization"

describe("WP-02 Agent Authorization and 14-tool Catalog", () => {
  it("maps all 14 tools accurately to canonical operations and mutation classifications", () => {
    const mutatingTools = [
      "lyrashield_scan_target",
      "lyrashield_create_report",
      "lyrashield_create_fix_proposal",
      "lyrashield_request_retest",
      "lyrashield_create_fix_pr",
    ]

    for (const tool of mutatingTools) {
      expect(TOOL_OPERATION_MAP[tool]).toBeDefined()
      expect(TOOL_OPERATION_MAP[tool].mutating).toBe(true)
    }

    const readTools = [
      "lyrashield_get_workspace",
      "lyrashield_list_targets",
      "lyrashield_get_target",
      "lyrashield_get_findings",
      "lyrashield_get_finding_detail",
      "lyrashield_get_scan_status",
      "lyrashield_get_reports",
      "lyrashield_check_eligibility",
      "lyrashield_get_verdict",
    ]

    for (const tool of readTools) {
      expect(TOOL_OPERATION_MAP[tool]).toBeDefined()
      expect(TOOL_OPERATION_MAP[tool].mutating).toBe(false)
    }
  })

  it("authorizes valid connection within target and operation scope", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: ["target-1", "target-2"],
      allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE, CANONICAL_OPERATIONS.REPORT_CREATE],
      allowedProfiles: ["SAFE", "QUICK"],
    }

    const result = checkDelegatedOperationAuthorization({
      connection,
      workspaceId: "ws-1",
      operationName: "lyrashield_scan_target",
      targetId: "target-1",
      profile: "SAFE",
    })

    expect(result.authorized).toBe(true)
    expect(result.canonicalOperation).toBe(CANONICAL_OPERATIONS.SCAN_CREATE)
  })

  it("denies access when workspace does not match", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allowedOperations: [],
      allowedProfiles: [],
    }

    const result = checkDelegatedOperationAuthorization({
      connection,
      workspaceId: "ws-other",
      operationName: "lyrashield_get_findings",
    })

    expect(result.authorized).toBe(false)
    expect(result.code).toBe("WORKSPACE_MISMATCH")
  })

  it("denies access when connection is REVOKED or PAUSED or expired", () => {
    const revoked = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "REVOKED" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allowedOperations: [],
      allowedProfiles: [],
    }

    expect(
      checkDelegatedOperationAuthorization({
        connection: revoked,
        workspaceId: "ws-1",
        operationName: "lyrashield_get_findings",
      }).code
    ).toBe("CONNECTION_REVOKED")

    const paused = {
      ...revoked,
      status: "PAUSED" as const,
    }

    expect(
      checkDelegatedOperationAuthorization({
        connection: paused,
        workspaceId: "ws-1",
        operationName: "lyrashield_get_findings",
      }).code
    ).toBe("CONNECTION_PAUSED")

    const expired = {
      ...revoked,
      status: "ACTIVE" as const,
      expiresAt: new Date(Date.now() - 10000),
    }

    expect(
      checkDelegatedOperationAuthorization({
        connection: expired,
        workspaceId: "ws-1",
        operationName: "lyrashield_get_findings",
      }).code
    ).toBe("CONNECTION_EXPIRED")
  })

  it("denies access when targetId is not allowed", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: ["target-allowed"],
      allTargets: false,
      allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE],
      allowedProfiles: [],
    }

    const result = checkDelegatedOperationAuthorization({
      connection,
      workspaceId: "ws-1",
      operationName: "lyrashield_scan_target",
      targetId: "target-forbidden",
    })

    expect(result.authorized).toBe(false)
    expect(result.code).toBe("TARGET_NOT_GRANTED")
  })

  it("denies access when operation is not allowed", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allowedOperations: [CANONICAL_OPERATIONS.WORKSPACE_READ],
      allowedProfiles: [],
    }

    const result = checkDelegatedOperationAuthorization({
      connection,
      workspaceId: "ws-1",
      operationName: "lyrashield_scan_target",
    })

    expect(result.authorized).toBe(false)
    expect(result.code).toBe("OPERATION_NOT_GRANTED")
  })

  it("denies access when scan profile is not allowed", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allTargets: true,
      allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE],
      allowedProfiles: ["SAFE", "QUICK"],
    }

    const result = checkDelegatedOperationAuthorization({
      connection,
      workspaceId: "ws-1",
      operationName: "lyrashield_scan_target",
      profile: "DEEP",
    })

    expect(result.authorized).toBe(false)
    expect(result.code).toBe("PROFILE_NOT_GRANTED")
  })

  it("fails closed for empty mutation grants and at the exact expiry boundary", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allTargets: true,
      allowedOperations: [],
      allowedProfiles: ["SAFE"],
    }
    expect(
      checkDelegatedOperationAuthorization({
        connection,
        workspaceId: "ws-1",
        operationName: "lyrashield_scan_target",
        targetId: "target-1",
        profile: "SAFE",
      }).code
    ).toBe("OPERATION_NOT_GRANTED")

    const now = Date.now()
    expect(
      checkDelegatedOperationAuthorization({
        connection: { ...connection, expiresAt: new Date(now) },
        workspaceId: "ws-1",
        operationName: "lyrashield_get_findings",
      }).code
    ).toBe("CONNECTION_EXPIRED")
  })
})
