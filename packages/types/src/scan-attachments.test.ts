import { describe, expect, it } from "vitest"
import {
  SCAN_ATTACHMENT_MAX_BYTES,
  SCAN_ATTACHMENT_MAX_COUNT,
  SCAN_ATTACHMENT_MAX_TOTAL_BYTES,
  scanAttachmentStagingName,
  validateScanAttachmentUpload,
} from "./scan-attachments"

describe("validateScanAttachmentUpload", () => {
  it("accepts the v1 text formats", () => {
    for (const [filename, mediaType] of [
      ["notes.txt", "text/plain"],
      ["design.md", "text/markdown"],
      ["contract.markdown", "text/markdown"],
      ["openapi.json", "application/json"],
      ["openapi.yaml", "application/yaml"],
      ["service.yml", "application/vnd.oai.openapi"],
      ["spec.yaml", "application/vnd.oai.openapi+yaml"],
    ] as const) {
      expect(validateScanAttachmentUpload(filename, mediaType, 512)).toMatchObject({ ok: true })
    }
  })

  it("rejects archives, executables, and active document formats", () => {
    for (const filename of [
      "bundle.zip",
      "src.tar.gz",
      "report.pdf",
      "spec.docx",
      "page.html",
      "diagram.svg",
      "run.exe",
      "script.sh",
      "macro.xlsm",
    ]) {
      const result = validateScanAttachmentUpload(filename, "text/plain", 512)
      expect(result).toMatchObject({ ok: false, code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" })
    }
  })

  it("rejects a mismatched media type on an allowed extension", () => {
    expect(validateScanAttachmentUpload("data.json", "application/pdf", 512)).toMatchObject({
      ok: false,
      code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED",
    })
    expect(validateScanAttachmentUpload("notes.txt", "application/x-msdownload", 512)).toMatchObject(
      { ok: false, code: "SCAN_ATTACHMENT_TYPE_NOT_ALLOWED" }
    )
  })

  it("rejects path-like and dotfile names", () => {
    for (const filename of ["../escape.txt", "a/b.txt", "..", ".env", "a\x00b.txt"]) {
      expect(validateScanAttachmentUpload(filename, "text/plain", 512)).toMatchObject({
        ok: false,
      })
    }
  })

  it("rejects empty and over-limit payloads", () => {
    expect(validateScanAttachmentUpload("a.txt", "text/plain", 0)).toMatchObject({ ok: false })
    expect(
      validateScanAttachmentUpload("a.txt", "text/plain", SCAN_ATTACHMENT_MAX_BYTES + 1)
    ).toMatchObject({ ok: false, code: "SCAN_ATTACHMENT_SIZE_EXCEEDED" })
  })
})

describe("scanAttachmentStagingName", () => {
  it("prefixes the artifact id so uploader names can never collide", () => {
    const a = scanAttachmentStagingName("att-1", "notes.txt")
    const b = scanAttachmentStagingName("att-2", "notes.txt")
    expect(a).not.toBe(b)
    expect(a.startsWith("att-1-")).toBe(true)
  })

  it("strips directory traversal from any stored filename", () => {
    const name = scanAttachmentStagingName("att-1", "../../etc/passwd")
    expect(name).not.toContain("..")
    expect(name).not.toContain("/")
    expect(name).toBe("att-1-passwd")
  })

  it("bounds length and never produces a hidden basename", () => {
    const long = `${"x".repeat(200)}.txt`
    const name = scanAttachmentStagingName("att-1", long)
    expect(name.length).toBeLessThanOrEqual(6 + 96)
    expect(scanAttachmentStagingName("att-1", "...")).toBe("att-1-attachment")
  })
})

describe("limits", () => {
  it("matches the execution plan's attachment cap", () => {
    expect(SCAN_ATTACHMENT_MAX_COUNT).toBe(20)
    expect(SCAN_ATTACHMENT_MAX_TOTAL_BYTES).toBeGreaterThanOrEqual(SCAN_ATTACHMENT_MAX_BYTES)
  })
})
