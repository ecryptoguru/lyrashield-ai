import { z } from "zod"
import type { LyraShieldClient } from "../client"

/** Shared wire contract; clients render the server-owned recovery decision. */
export const OperationStatusSchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(["PENDING", "EXECUTING", "COMPLETED", "FAILED", "CONFLICT"]),
  reasonCode: z.string().nullable(),
  resultLocation: z.string().nullable(),
  recovery: z.enum(["wait", "poll", "retry_new_key", "none"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type OperationStatus = z.infer<typeof OperationStatusSchema>

export function getOperationStatus(
  client: LyraShieldClient,
  id: string,
  workspaceId = client.workspaceId
): Promise<OperationStatus> {
  const query = new URLSearchParams(workspaceId ? { workspaceId } : {})
  return client.request("GET", `/agent-operations/${encodeURIComponent(id)}?${query}`, {
    parse: (data) => OperationStatusSchema.parse(data),
  })
}
