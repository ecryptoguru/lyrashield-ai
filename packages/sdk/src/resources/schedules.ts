import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { ScheduleListSchema, ScheduleSchema } from "../schemas"

export interface ListSchedulesQuery {
  workspaceId?: string
  targetId?: string
  cursor?: string
  limit?: number
}

export interface CreateScheduleInput {
  workspaceId?: string
  targetId: string
  frequency: string
  mode?: string
}

export function listSchedules(
  client: LyraShieldClient,
  query: ListSchedulesQuery = {}
): Promise<z.infer<typeof ScheduleListSchema>> {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.targetId) params.set("targetId", query.targetId)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  return client.request("GET", qs ? `/schedules?${qs}` : "/schedules", {
    parse: (data) => ScheduleListSchema.parse(data),
  })
}

export function createSchedule(
  client: LyraShieldClient,
  input: CreateScheduleInput
): Promise<z.infer<typeof ScheduleSchema>> {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", "/schedules", {
    body,
    parse: (data) => ScheduleSchema.parse(data),
  })
}
