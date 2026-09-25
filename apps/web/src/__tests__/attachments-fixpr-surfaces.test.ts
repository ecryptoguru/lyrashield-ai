import { describe, expect, it } from "vitest"
import {
  AUTOMATION_WORKFLOWS,
  CANONICAL_OPERATIONS,
  MUTATING_CANONICAL_OPERATIONS,
  TOOL_OPERATION_MAP,
} from "@lyrashield/db"
import { PERMISSIONS } from "@lyrashield/auth"
import { OPERATIONAL_PERMISSIONS } from "@lyrashield/auth/permissions"

/**
 * Cross-surface consistency for the attachment + fix-PR exposure (D2):
 * the canonical-operation registry, the MCP tool map, the mutating operation
 * set, the delegated automation workflows and the permission catalog must all
 * agree, or a tool could execute without the grant it claims to require.
 */
describe("D2 attachment + fix-PR surfaces", () => {
  it("registers the canonical attachment operations exactly once", () => {
    expect(CANONICAL_OPERATIONS.ATTACHMENT_LIST).toBe("scan_attachment.list")
    expect(CANONICAL_OPERATIONS.ATTACHMENT_UPLOAD).toBe("scan_attachment.upload")
    expect(CANONICAL_OPERATIONS.ATTACHMENT_DELETE).toBe("scan_attachment.delete")
  })

  it("classifies upload/delete as mutating and list as read-only", () => {
    expect(MUTATING_CANONICAL_OPERATIONS.has(CANONICAL_OPERATIONS.ATTACHMENT_UPLOAD)).toBe(true)
    expect(MUTATING_CANONICAL_OPERATIONS.has(CANONICAL_OPERATIONS.ATTACHMENT_DELETE)).toBe(true)
    expect(MUTATING_CANONICAL_OPERATIONS.has(CANONICAL_OPERATIONS.ATTACHMENT_LIST)).toBe(false)
  })

  it("maps every new MCP tool to its canonical operation and mutation class", () => {
    expect(TOOL_OPERATION_MAP.lyrashield_list_scan_attachments).toMatchObject({
      canonicalOperation: "scan_attachment.list",
      mutating: false,
      isBillable: false,
    })
    expect(TOOL_OPERATION_MAP.lyrashield_upload_scan_attachment).toMatchObject({
      canonicalOperation: "scan_attachment.upload",
      mutating: true,
      isBillable: false,
    })
    expect(TOOL_OPERATION_MAP.lyrashield_delete_scan_attachment).toMatchObject({
      canonicalOperation: "scan_attachment.delete",
      mutating: true,
      isBillable: false,
    })
    expect(TOOL_OPERATION_MAP.lyrashield_request_fix_pr).toMatchObject({
      canonicalOperation: "fix_pr.create",
      mutating: true,
      isBillable: false,
    })
  })

  it("keeps the existing scan.cancel mapping intact alongside the new entries", () => {
    expect(TOOL_OPERATION_MAP.lyrashield_cancel_scan).toMatchObject({
      canonicalOperation: "scan.cancel",
      mutating: true,
    })
  })

  it("exposes a dedicated attachments automation bundle without mutating older workflows", () => {
    const attachments = AUTOMATION_WORKFLOWS.find((wf) => wf.id === "attachments")
    expect(attachments).toBeDefined()
    expect([...attachments!.operations].sort()).toEqual(
      ["scan_attachment.list", "scan_attachment.upload", "scan_attachment.delete"].sort()
    )
    // Pre-existing bundles must not absorb attachment ops — an old scans
    // grant can never double as attachment authority.
    const legacy = AUTOMATION_WORKFLOWS.find((wf) => wf.id === "scans")!
    expect(legacy.operations).not.toContain("scan_attachment.upload")
    expect(legacy.operations).not.toContain("scan_attachment.delete")
  })

  it("grants every operational role the dedicated attachment permissions", () => {
    expect(PERMISSIONS.attachment.upload).toBe("attachment:upload")
    expect(PERMISSIONS.attachment.delete).toBe("attachment:delete")
    expect(OPERATIONAL_PERMISSIONS).toContain("attachment:upload")
    expect(OPERATIONAL_PERMISSIONS).toContain("attachment:delete")
    // Read-side stays on the existing scan.view permission — no new read perm.
    expect(PERMISSIONS.scan.view).toBe("scan:view")
  })

  it("maps every mutating canonical op used by the tool map into the mutating set", () => {
    for (const descriptor of Object.values(TOOL_OPERATION_MAP)) {
      if (!descriptor.mutating) continue
      expect(MUTATING_CANONICAL_OPERATIONS.has(descriptor.canonicalOperation)).toBe(true)
    }
  })
})
