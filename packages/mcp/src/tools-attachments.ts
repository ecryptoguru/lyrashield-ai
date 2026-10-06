import { createHash, randomUUID } from "node:crypto"
import {
  LyraShieldError,
  defaultScanAttachmentMediaType,
  deleteScanAttachment,
  listScanAttachments,
  requestFixPr,
  uploadScanAttachment,
} from "@lyrashield/sdk"
import {
  IDEMPOTENCY_KEY_PROPERTY,
  getClient,
  makeErrorResult,
  makeToolResult,
  type McpTool,
  type ToolHandlerContext,
} from "./tool-shared"

// Attachment and fix-PR tools wrap the same REST surface as the dashboard.
// Uploads accept UTF-8 text only; an argument cannot name a host path or URL.

/**
 * Rest request identity for mutating tools, mirroring `apiCall`'s recorded
 * path convention: a caller-supplied key is folded into an `mcp:`-prefixed
 * SHA-256 so the hosted outer operation and the REST operation never collide;
 * without a key each call gets a fresh identity.
 */
function mcpToolIdempotencyKey(raw: unknown): string {
  if (raw !== undefined && (typeof raw !== "string" || !raw.trim() || raw.length > 128)) {
    throw new Error("Invalid idempotency key")
  }
  return typeof raw === "string"
    ? `mcp:${createHash("sha256").update(raw).digest("hex")}`
    : randomUUID()
}

export function createListScanAttachmentsTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_list_scan_attachments",
    mutating: false,
    description:
      "List the workspace's active scan attachments (id, filename, media type, size, checksum). Attachments are immutable input evidence referenced by id in scan runs — never host paths.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const client = getClient(context)
        const data = await listScanAttachments(client, args.workspaceId as string)
        return makeToolResult(data)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createUploadScanAttachmentTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_upload_scan_attachment",
    mutating: true,
    description:
      "Upload a UTF-8 text attachment as workspace input evidence for future scans. `content` is the attachment's literal text — never a local file path, URL, or binary (NUL bytes are rejected). Allowed types: plain text, Markdown, JSON, YAML and OpenAPI documents. This MCP tool bounds content to ~100 KB; larger files up to 1 MiB upload via the CLI (lyrashield attachments upload), SDK, or REST. Returns the attachment id to pass as attachmentIds on scan runs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
        workspaceId: { type: "string", description: "Workspace ID" },
        filename: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Attachment filename (letters, digits, dots, dashes, underscores, spaces; .txt/.md/.markdown/.json/.yaml/.yml only — never a path).",
        },
        content: {
          type: "string",
          minLength: 1,
          // ~100 KB cap keeps the serialized tool call under the existing
          // 200k-char security-guard bound with JSON-escaping headroom; the
          // REST boundary itself accepts 1 MiB via CLI/SDK.
          maxLength: 100_000,
          description:
            "The attachment's literal UTF-8 text content — not a path or URL. Up to ~100 KB here.",
        },
        mediaType: {
          type: "string",
          description:
            "Optional declared media type; must be allowed for the filename's extension (default: the extension's canonical type).",
        },
      },
      required: ["workspaceId", "filename", "content"],
    },
    handler: async (args) => {
      try {
        const filename = args.filename as string
        const content = args.content as string
        const mediaType =
          typeof args.mediaType === "string" && args.mediaType.trim()
            ? args.mediaType
            : defaultScanAttachmentMediaType(filename)
        if (!mediaType) {
          return makeErrorResult(
            `Cannot determine an allowed media type for "${filename}". Attachments accept .txt, .md, .markdown, .json, .yaml and .yml only.`
          )
        }
        const bytes = new TextEncoder().encode(content)
        const client = getClient(context)
        const data = await uploadScanAttachment(client, {
          workspaceId: args.workspaceId as string,
          filename,
          content: bytes,
          mediaType,
          idempotencyKey: mcpToolIdempotencyKey(args.idempotencyKey),
        })
        return makeToolResult({ action: "scan_attachment_uploaded", attachment: data })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createDeleteScanAttachmentTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_delete_scan_attachment",
    mutating: true,
    description:
      "Delete a workspace scan attachment by id. The row is removed so it can never be attached to a new scan; the stored encrypted object is removed durably. Deleting is permanent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
        workspaceId: { type: "string", description: "Workspace ID" },
        attachmentId: { type: "string", description: "Attachment ID to delete" },
      },
      required: ["workspaceId", "attachmentId"],
    },
    handler: async (args) => {
      try {
        const client = getClient(context)
        const data = await deleteScanAttachment(client, args.attachmentId as string, {
          workspaceId: args.workspaceId as string,
          idempotencyKey: mcpToolIdempotencyKey(args.idempotencyKey),
        })
        return makeToolResult({ action: "scan_attachment_deleted", result: data })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createRequestFixPrTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_request_fix_pr",
    mutating: true,
    description:
      "Request a pull request for a recorded fix proposal's server-generated patch. Nothing is merged automatically. The outcome is honest: `pending_approval` returns an approval URL for a human to confirm, `opened` returns the PR coordinates, `failed`/`rejected` explain why no PR exists.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
        workspaceId: { type: "string", description: "Workspace ID" },
        proposalId: {
          type: "string",
          description: "Fix proposal ID with a server-generated approved patch",
        },
      },
      required: ["workspaceId", "proposalId"],
    },
    handler: async (args) => {
      try {
        const client = getClient(context)
        const outcome = await requestFixPr(client, args.proposalId as string, {
          workspaceId: args.workspaceId as string,
          idempotencyKey: mcpToolIdempotencyKey(args.idempotencyKey),
        })
        return makeToolResult({
          action:
            outcome.status === "opened"
              ? "fix_pr_opened"
              : outcome.status === "pending_approval"
                ? "fix_pr_pending_approval"
                : "fix_pr_not_created",
          outcome,
        })
      } catch (err) {
        // A rejected patch arrives as a 422 PATCH_REJECTED error — surface it
        // as a structured error so agents never mistake it for a success.
        if (err instanceof LyraShieldError) {
          const payload: Record<string, unknown> = {
            error: err.message,
            code: err.code,
            status: err.status,
          }
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: true,
            structuredContent: payload,
          }
        }
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
