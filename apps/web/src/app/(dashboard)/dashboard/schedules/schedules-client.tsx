"use client"

import { useState, useEffect, useCallback } from "react"
import { Calendar, Plus, AlertCircle, Trash2, Power } from "lucide-react"
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
import { formatDate, formatDateTime } from "@/lib/date-format"
import { Skeleton } from "@/components/ui/skeleton"
import { getScanPreset, SCAN_PRESETS, type ScanPresetId } from "@/lib/scan-presets"

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

  const loadSchedules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGetPaginated<ScheduleItem>(`/api/schedules`, { workspaceId })
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
    apiGetPaginated<ScheduleItem>(`/api/schedules`, { workspaceId })
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

    apiGetPaginated<TargetOption>(`/api/targets`, { workspaceId })
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
    if (!window.confirm("Are you sure you want to delete this schedule?")) return
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
            <h3 className="text-sm font-medium">Create Scheduled Scan</h3>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Cron Expression" htmlFor="cron-expr">
                <Input
                  id="cron-expr"
                  type="text"
                  className="font-mono"
                  placeholder="0 0 * * 0"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
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
            <p className="text-muted-foreground text-xs">
              {getScanPreset(presetId).description} Maximum engine spend: $
              {getScanPreset(presetId).maxCostUsd.toFixed(2)} per run.
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
        <div className="space-y-3" aria-busy="true" aria-label="Loading schedules">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-28 w-full" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="No scheduled scans"
          description="Set up recurring scans to monitor your targets on a schedule."
        />
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <Card
              key={schedule.id}
              className="hover:shadow-card-hover p-4 transition-shadow duration-200"
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
                  <p className="text-muted-foreground font-mono text-sm">{schedule.cron}</p>
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
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete schedule"
                    onClick={() => void handleDelete(schedule.id)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<ScheduleItem>(`/api/schedules`, {
                workspaceId,
                cursor,
              })
              return { items: res.items as unknown[], nextCursor: res.nextCursor }
            }}
            onItems={(items) => setSchedules((prev) => [...prev, ...(items as ScheduleItem[])])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
