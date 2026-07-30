/**
 * Reusable OpenAPI 3.1 components for the /api/v1 spec.
 */

export const securitySchemes = {
  bearerAuth: {
    type: "http" as const,
    scheme: "bearer",
    bearerFormat: "lsk_<key>",
    description:
      "Workspace-scoped API key. Pass `Authorization: Bearer lsk_...`. " +
      "Keys are bound to a single workspace and must be supplied with `workspaceId` on every call. " +
      "Two scopes exist: `read` and `write`. A `read`-scoped key is only allowed for: " +
      "scan:view, finding:view, retest:view, schedule:view, report:download, audit:view, agent:view, notification:view. " +
      "All other actions, including creating scans, findings updates, retests, schedules, reports, and targets, require `write`.",
  },
}

export const workspaceIdParam = {
  name: "workspaceId",
  in: "query" as const,
  required: true,
  description:
    "The workspace UUID the request operates on. Caller-supplied, not inferred from the API key. " +
    "A key bound to workspace A is rejected for workspace B.",
  schema: { type: "string" as const, minLength: 1 },
}

export const idPathParam = {
  name: "id",
  in: "path" as const,
  required: true,
  description: "Resource UUID",
  schema: { type: "string" as const, minLength: 1 },
}

export const successEnvelope = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const, "const": true as const, description: "Request succeeded" },
    data: { description: "Response payload" },
  },
  required: ["success", "data"],
}

export const errorEnvelope = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const, "const": false as const, description: "Request failed" },
    error: {
      type: "object" as const,
      properties: {
        code: { type: "string" as const, description: "Stable machine-readable error code" },
        message: { type: "string" as const, description: "Human-readable error description" },
      },
      required: ["code", "message"],
    },
  },
  required: ["success", "error"],
}

export const paginatedEnvelope = {
  type: "object" as const,
  properties: {
    items: {
      type: "array" as const,
      description: "Page of results",
      items: {},
    },
    nextCursor: {
      description: "Opaque cursor for the next page, or null on the last page",
      oneOf: [{ type: "string" as const }, { type: "null" as const }],
    },
    total: { type: "integer" as const, description: "Optional total count across all pages" },
  },
  required: ["items", "nextCursor"],
}
