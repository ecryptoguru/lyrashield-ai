"use client"

import { useState, useEffect, useCallback } from "react"
import { z } from "zod"
import { Calendar, Plus, AlertCircle, Trash2, Power, ChevronDown } from "lucide-react"
import {
  Button,
  Badge,
  Card,
  EmptyState,
  Spinner,
  LoadMore,
  Input,
  Select,
  FormField,
} from "@lyrashield/ui"
import { apiGetPaginated, apiPost, apiPatch, apiDelete } from "@/lib/api-client"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { formatDate, formatDateTime } from "@/lib/date-format"
import { Skeleton } from "@/components/ui/skeleton"
import { getScanPreset, SCAN_PRESETS, type ScanPresetId } from "@/lib/scan-presets"
import { InlineConfirm } from "@/components/ui/inline-confirm"

interface ScheduleItem {
  id: string
  targetId: string
  cron: string
  goal: string
  mode: string
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
  target: { id: string; name: string; type: string; url: string | null }
}

interface TargetOption {
  id: string
  name: string
  type: string
}

const targetOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
  })
  .passthrough()

const targetOptionsPaginatedSchema = paginatedResponseSchema(targetOptionSchema)

const scheduleItemSchema = z
  .object({
    id: z.string(),
    targetId: z.string(),
    cron: z.string(),
    goal: z.string(),
    mode: z.string(),
    enabled: z.boolean(),
    lastRunAt: z.string().datetime().or(z.string()).nullable(),
    nextRunAt: z.string().datetime().or(z.string()).nullable(),
    createdAt: z.string().datetime().or(z.string()),
    target: z
      .object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        url: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough()

const schedulesPaginatedSchema = paginatedResponseSchema(scheduleItemSchema)

function describeCron(cron: string): string {
  const presets: Record<string, string> = {
    "0 0 * * 0": "Every Sunday at 00:00 UTC",
    "0 0 * * *": "Every day at 00:00 UTC",
    "30 8 * * *": "Every day at 08:30 UTC",
    "0 0 1 * *": "On the first day of every month at 00:00 UTC",
  }
  return presets[cron.trim()] ?? "Custom UTC schedule — verify the cron expression before saving"
}

export function SchedulesClient({ workspaceId }: { workspaceId: string }) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [targets, setTargets] = useState<TargetOption[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState("")
  const [cron, setCron] = useState("0 0 * * 0")
  const [presetId, setPresetId] = useState<ScanPresetId>("WEEKLY_MONITOR")
  const [creating, setCreating] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [frequency, setFrequency] = useState("WEEKLY")
  const selectedTargetUsesEngine =
    targets.find((target) => target.id === selectedTargetId)?.type === "REPO"

  const loadSchedules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGetPaginated(
        `/api/schedules`,
        { workspaceId },
        { schema: schedulesPaginatedSchema }
      )
      setSchedules(res.items)
      setNextCursor(res.nextCursor)
      setError(null)
    } catch {
      setSchedules([])
      setError("Failed to load schedules.")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    apiGetPaginated(`/api/schedules`, { workspaceId }, { schema: schedulesPaginatedSchema })
      .then((res) => {
        if (cancelled) return
        setSchedules(res.items)
        setNextCursor(res.nextCursor)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError("Failed to load schedules.")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })

    apiGetPaginated(`/api/targets`, { workspaceId }, { schema: targetOptionsPaginatedSchema })
      .then((res) => {
        if (cancelled) return
        setTargets(res.items)
      })
      .catch(() => {
        // targets optional
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      const preset = getScanPreset(presetId)
      await apiPost(`/api/schedules`, {
        workspaceId,
        targetId: selectedTargetId,
        cron,
        goal: preset.goal,
        mode: preset.mode,
      })
      setShowCreateForm(false)
      setSelectedTargetId("")
      setCron("0 0 * * 0")
      setPresetId("WEEKLY_MONITOR")
      setFrequency("WEEKLY")
      setShowAdvanced(false)
      await loadSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule.")
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (scheduleId: string, currentEnabled: boolean) => {
    try {
      await apiPatch(`/api/schedules/${scheduleId}`, {
        workspaceId,
        enabled: !currentEnabled,
      })
      setSchedules((prev) =>
        prev.map((s) => (s.id === scheduleId ? { ...s, enabled: !currentEnabled } : s))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle schedule.")
    }
  }

  const handleDelete = async (scheduleId: string) => {
    try {
      await apiDelete(`/api/schedules/${scheduleId}?workspaceId=${workspaceId}`)
      setSchedules((prev) => prev.filter((s) => s.id !== scheduleId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule.")
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Schedules</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Set up recurring scans to monitor your targets
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          New Schedule
        </Button>
      </div>

      {showCreateForm && (
        <Card className="mb-4 p-4">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">New scheduled scan</h3>
            {targets.length > 0 ? (
              <FormField label="Target" htmlFor="schedule-target">
                <Select
                  id="schedule-target"
                  value={selectedTargetId}
                  onChange={(e) => setSelectedTargetId(e.target.value)}
                >
                  <option value="">Select a target</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.type})
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : (
              <p className="text-muted-foreground text-sm">
                No targets available. Create a target first.
              </p>
            )}
            <FormField label="Frequency" htmlFor="frequency">
              <Select
                id="frequency"
                value={frequency}
                onChange={(e) => {
                  setFrequency(e.target.value)
                  const cronMap: Record<string, string> = {
                    DAILY: "0 0 * * *",
                    WEEKLY: "0 0 * * 0",
                    MONTHLY: "0 0 1 * *",
                  }
                  const mapped = cronMap[e.target.value]
                  if (mapped) setCron(mapped)
                }}
              >
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
                <option value="CUSTOM" disabled>
                  Custom cron
                </option>
              </Select>
            </FormField>
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
              >
                <ChevronDown
                  className={`size-4 transition-transform duration-(--duration-fast) ease-out ${showAdvanced ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                Advanced
              </button>
              {showAdvanced && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField label="Cron Expression" htmlFor="cron-expr">
                    <Input
                      id="cron-expr"
                      type="text"
                      className="font-mono"
                      placeholder="0 0 * * 0"
                      value={cron}
                      onChange={(e) => {
                        const val = e.target.value
                        setCron(val)
                        const reverseMap: Record<string, string> = {
                          "0 0 * * *": "DAILY",
                          "0 0 * * 0": "WEEKLY",
                          "0 0 1 * *": "MONTHLY",
                        }
                        const matched = reverseMap[val.trim()]
                        setFrequency(matched ?? "CUSTOM")
                      }}
                    />
                    <p className="text-muted-foreground mt-1 text-xs">{describeCron(cron)}</p>
                  </FormField>
                  <FormField label="Review depth" htmlFor="scan-preset">
                    <Select
                      id="scan-preset"
                      value={presetId}
                      onChange={(e) => setPresetId(e.target.value as ScanPresetId)}
                    >
                      {Object.entries(SCAN_PRESETS).map(([id, preset]) => (
                        <option key={id} value={id}>
                          {preset.label}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                </div>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              {getScanPreset(presetId).description}{" "}
              {selectedTargetId && !selectedTargetUsesEngine
                ? "This target uses deterministic scanners."
                : "A protected run limit is applied automatically."}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={creating || !selectedTargetId}
                onClick={() => void handleCreate()}
              >
                {creating ? <Spinner /> : "Create"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {error && (
        <Card className="border-destructive/50 mb-4 p-4">
          <div className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setError(null)
                void loadSchedules()
              }}
            >
              Retry
            </Button>
          </div>
        </Card>
      )}

      {loading && schedules.length === 0 ? (
        <div
          className="space-y-3"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="Loading schedules"
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-28 w-full" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="No scheduled scans"
          description="Set up recurring scans to monitor your targets on a schedule."
          action={
            <Button onClick={() => setShowCreateForm(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              New Schedule
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <Card
              key={schedule.id}
              className="hover:shadow-card-hover p-4 transition-shadow duration-(--duration-base) ease-out"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="truncate font-medium">{schedule.target.name}</h3>
                    <Badge variant="info">{schedule.goal}</Badge>
                    <Badge variant="muted">{schedule.mode}</Badge>
                    <Badge variant={schedule.enabled ? "success" : "muted"}>
                      {schedule.enabled ? "active" : "disabled"}
                    </Badge>
                  </div>
                  <p className="text-sm">{describeCron(schedule.cron)}</p>
                  <p className="text-muted-foreground font-mono text-xs">{schedule.cron}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Created {formatDate(schedule.createdAt)}
                    {schedule.lastRunAt && <> · Last run {formatDateTime(schedule.lastRunAt)}</>}
                    {schedule.nextRunAt && <> · Next run {formatDateTime(schedule.nextRunAt)}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
                    onClick={() => void handleToggle(schedule.id, schedule.enabled)}
                  >
                    <Power className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <InlineConfirm
                    triggerIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                    aria-label="Delete schedule"
                    message="Delete this schedule?"
                    confirmLabel="Delete"
                    onConfirm={() => handleDelete(schedule.id)}
                  />
                </div>
              </div>
            </Card>
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated(
                `/api/schedules`,
                {
                  workspaceId,
                  cursor,
                },
                { schema: schedulesPaginatedSchema }
              )
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => setSchedules((prev) => [...prev, ...items])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
