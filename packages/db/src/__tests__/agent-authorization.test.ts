import { describe, expect, it } from "vitest"
import {
  CANONICAL_OPERATIONS,
  TOOL_OPERATION_MAP,
  checkDelegatedOperationAuthorization,
} from "../agent-authorization"

describe("WP-02 Agent Authorization and 14-tool Catalog", () => {
  it("maps tools accurately to canonical operations and mutation classifications", () => {
    const mutatingTools = [
      "lyrashield_scan_target",
      "lyrashield_create_report",
      "lyrashield_create_fix_proposal",
      "lyrashield_request_retest",
      "lyrashield_create_fix_pr",
      "lyrashield_cancel_scan",
      "lyrashield_upload_scan_attachment",
      "lyrashield_delete_scan_attachment",
      "lyrashield_request_fix_pr",

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
      "lyrashield_list_scan_attachments",
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

  it("requires an explicit scan.cancel grant — scan.create alone does not authorize cancel", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allTargets: true,
      allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE],
      allowedProfiles: ["STANDARD"],
    }

    // A scan-create grant does not imply cancel authority.
    expect(
      checkDelegatedOperationAuthorization({
        connection,
        workspaceId: "ws-1",
        operationName: "lyrashield_cancel_scan",
        targetId: "target-1",
        profile: "STANDARD",
      }).code
    ).toBe("OPERATION_NOT_GRANTED")

    // An explicit scan.cancel grant authorizes it.
    const granted = {
      ...connection,
      allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE, CANONICAL_OPERATIONS.SCAN_CANCEL],
    }
    expect(
      checkDelegatedOperationAuthorization({
        connection: granted,
        workspaceId: "ws-1",
        operationName: "lyrashield_cancel_scan",
        targetId: "target-1",
        profile: "STANDARD",
      }).authorized
    ).toBe(true)
  })

  it("authorizes scan.cancel on a granted target and denies a target outside the grant", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: ["target-1"],
      allTargets: false,
      allowedOperations: [CANONICAL_OPERATIONS.SCAN_CANCEL],
      allowedProfiles: ["STANDARD"],
    }

    const allowed = checkDelegatedOperationAuthorization({
      connection,
      workspaceId: "ws-1",
      operationName: "lyrashield_cancel_scan",
      targetId: "target-1",
      profile: "STANDARD",
    })
    expect(allowed).toMatchObject({
      authorized: true,
      canonicalOperation: CANONICAL_OPERATIONS.SCAN_CANCEL,
    })

    expect(
      checkDelegatedOperationAuthorization({
        connection,
        workspaceId: "ws-1",
        operationName: "lyrashield_cancel_scan",
        targetId: "target-2",
        profile: "STANDARD",
      }).code
    ).toBe("TARGET_NOT_GRANTED")
  })

  it("attachment upload/delete require their own grants — scan.create is not widened into them", () => {
    const base = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD"],
    }

    // A scan.create-only (pre-existing) grant never uploads or deletes.
    const legacy = { ...base, allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE] }
    for (const tool of ["lyrashield_upload_scan_attachment", "lyrashield_delete_scan_attachment"]) {
      expect(
        checkDelegatedOperationAuthorization({
          connection: legacy,
          workspaceId: "ws-1",
          operationName: tool,
        }).code
      ).toBe("OPERATION_NOT_GRANTED")
    }

    // Explicit attachment grants authorize, each mapped to its canonical op.
    const upload = { ...base, allowedOperations: [CANONICAL_OPERATIONS.ATTACHMENT_UPLOAD] }
    expect(
      checkDelegatedOperationAuthorization({
        connection: upload,
        workspaceId: "ws-1",
        operationName: "lyrashield_upload_scan_attachment",
      })
    ).toMatchObject({
      authorized: true,
      canonicalOperation: CANONICAL_OPERATIONS.ATTACHMENT_UPLOAD,
    })
    expect(
      checkDelegatedOperationAuthorization({
        connection: upload,
        workspaceId: "ws-1",
        operationName: "lyrashield_delete_scan_attachment",
      }).code
    ).toBe("OPERATION_NOT_GRANTED")

    const deleter = { ...base, allowedOperations: [CANONICAL_OPERATIONS.ATTACHMENT_DELETE] }
    expect(
      checkDelegatedOperationAuthorization({
        connection: deleter,
        workspaceId: "ws-1",
        operationName: "lyrashield_delete_scan_attachment",
      })
    ).toMatchObject({
      authorized: true,
      canonicalOperation: CANONICAL_OPERATIONS.ATTACHMENT_DELETE,
    })
  })

  it("lyrashield_request_fix_pr maps to fix_pr.create and honors target-scoped grants", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: ["target-1"],
      allTargets: false,
      allowedOperations: [CANONICAL_OPERATIONS.FIX_PR_CREATE],
      allowedProfiles: ["STANDARD"],
    }

    expect(
      checkDelegatedOperationAuthorization({
        connection,
        workspaceId: "ws-1",
        operationName: "lyrashield_request_fix_pr",
        targetId: "target-1",
      })
    ).toMatchObject({
      authorized: true,
      canonicalOperation: CANONICAL_OPERATIONS.FIX_PR_CREATE,
    })

    // A proposal on a non-granted target (resolved server-side to target-2)
    // must not pass a target-scoped grant.
    expect(
      checkDelegatedOperationAuthorization({
        connection,
        workspaceId: "ws-1",
        operationName: "lyrashield_request_fix_pr",
        targetId: "target-2",
      }).code
    ).toBe("TARGET_NOT_GRANTED")
  })

  it("lyrashield_list_scan_attachments is read-only and needs no mutation grant", () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      expiresAt: null,
      allowedTargetIds: [],
      allTargets: false,
      allowedOperations: [],
      allowedProfiles: [],
    }
    expect(
      checkDelegatedOperationAuthorization({
        connection,
        workspaceId: "ws-1",
        operationName: "lyrashield_list_scan_attachments",
      }).authorized
    ).toBe(true)
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
