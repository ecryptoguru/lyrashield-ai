"use client"

import { useState, useEffect, useCallback } from "react"
import { Calendar, Plus, AlertCircle, Trash2, Power } from "lucide-react"
import { Button, Badge, Card, EmptyState, Spinner, LoadMore } from "@lyrashield/ui"
import { apiGetPaginated, apiPost, apiPatch, apiDelete } from "@/lib/api-client"

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

export function SchedulesClient({ workspaceId }: { workspaceId: string }) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [targets, setTargets] = useState<TargetOption[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState("")
  const [cron, setCron] = useState("0 0 * * 0")
  const [goal, setGoal] = useState("url_scan")
  const [mode, setMode] = useState("SAFE")
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

    return () => { cancelled = true }
  }, [workspaceId])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      await apiPost(`/api/schedules`, {
        workspaceId,
        targetId: selectedTargetId,
        cron,
        goal,
        mode,
      })
      setShowCreateForm(false)
      setSelectedTargetId("")
      setCron("0 0 * * 0")
      setGoal("url_scan")
      setMode("SAFE")
      await loadSchedules()
    } catch {
      setError("Failed to create schedule.")
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
    } catch {
      setError("Failed to toggle schedule.")
    }
  }

  const handleDelete = async (scheduleId: string) => {
    if (!window.confirm("Are you sure you want to delete this schedule?")) return
    try {
      await apiDelete(`/api/schedules/${scheduleId}?workspaceId=${workspaceId}`)
      setSchedules((prev) => prev.filter((s) => s.id !== scheduleId))
    } catch {
      setError("Failed to delete schedule.")
    }
  }

  if (loading && schedules.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Schedules</h1>
        <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
          <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
          New Schedule
        </Button>
      </div>

      {showCreateForm && (
        <Card className="mb-4 p-4">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Create Scheduled Scan</h3>
            {targets.length > 0 ? (
              <select
                className="w-full rounded-lg border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
              >
                <option value="">Select a target</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-muted-foreground">No targets available. Create a target first.</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Cron Expression</label>
                <input
                  type="text"
                  className="w-full rounded-lg border bg-background p-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="0 0 * * 0"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">Default: weekly (Sunday midnight)</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Scan Goal</label>
                <select
                  className="w-full rounded-lg border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                >
                  <option value="url_scan">URL Scan</option>
                  <option value="sca">Software Composition Analysis</option>
                  <option value="secrets">Secrets Scan</option>
                  <option value="full_audit">Full Audit</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Mode</label>
              <select
                className="w-full rounded-lg border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="SAFE">Safe</option>
                <option value="AGGRESSIVE">Aggressive</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={creating || !selectedTargetId} onClick={() => void handleCreate()}>
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
        <Card className="mb-4 p-4 border-destructive/50">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setError(null); void loadSchedules() }}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {schedules.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="No scheduled scans"
          description="Set up recurring scans to monitor your targets on a schedule."
        />
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <Card key={schedule.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium truncate">{schedule.target.name}</h3>
                    <Badge variant="info">{schedule.goal}</Badge>
                    <Badge variant="muted">{schedule.mode}</Badge>
                    <Badge variant={schedule.enabled ? "success" : "muted"}>
                      {schedule.enabled ? "active" : "disabled"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground font-mono">{schedule.cron}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Created {new Date(schedule.createdAt).toLocaleDateString()}
                    {schedule.lastRunAt && (
                      <> · Last run {new Date(schedule.lastRunAt).toLocaleString()}</>
                    )}
                    {schedule.nextRunAt && (
                      <> · Next run {new Date(schedule.nextRunAt).toLocaleString()}</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
                    onClick={() => void handleToggle(schedule.id, schedule.enabled)}
                  >
                    <Power className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete schedule"
                    onClick={() => void handleDelete(schedule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<ScheduleItem>(
                `/api/schedules`, { workspaceId, cursor }
              )
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
