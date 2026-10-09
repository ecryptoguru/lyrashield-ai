"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { z } from "zod"
import Link from "next/link"
import { Calendar, Plus, Trash2, Power, ChevronDown } from "lucide-react"
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
  buttonVariants,
} from "@lyrashield/ui"
import { apiGetPaginated, apiPost, apiPatch, apiDelete } from "@/lib/api-client"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { formatDate, formatDateTimeUtc } from "@/lib/date-format"
import { getGoalLabel, modeLabel } from "@/lib/labels"
import { Skeleton } from "@/components/ui/skeleton"
import { getManualScanOptions } from "@/lib/scan-presets"
import { scheduleTargetOptionLabel } from "@/lib/schedule-labels"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { DashboardErrorCard } from "@/components/dashboard-error-card"

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
  target: { id: string; name: string; type: string; url: string | null; apiSpecUrl: string | null }
}

interface TargetOption {
  id: string
  name: string
  type: string
  apiSpecUrl: string | null
}

const targetOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    apiSpecUrl: z.string().nullable(),
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
        apiSpecUrl: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough()

const schedulesPaginatedSchema = paginatedResponseSchema(scheduleItemSchema)

type ScheduleOption = ReturnType<typeof getManualScanOptions>[number]

function ScheduleAdvancedToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls="schedule-advanced"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-1 rounded-md text-xs font-medium focus-visible:ring-2"
    >
      <ChevronDown
        className={`size-4 transition-transform duration-(--duration-fast) ease-out ${open ? "rotate-180" : ""}`}
        aria-hidden="true"
      />
      Advanced
    </button>
  )
}

function ScheduleCreateForm({
  targets,
  selectedTargetId,
  onTarget,
  frequency,
  onFrequency,
  cron,
  onCron,
  onPreset,
  showAdvanced,
  onToggleAdvanced,
  options,
  selectedOption,
  targetDetails,
  usesEngine,
  modeResetNotice,
  creating,
  onCreate,
  onCancel,
}: {
  targets: TargetOption[]
  selectedTargetId: string
  onTarget: (id: string) => void
  frequency: string
  onFrequency: (value: string) => void
  cron: string
  onCron: (value: string) => void
  showAdvanced: boolean
  onToggleAdvanced: () => void
  options: ScheduleOption[]
  selectedOption: ScheduleOption | undefined
  onPreset: (value: string) => void
  targetDetails: TargetOption | undefined
  usesEngine: boolean | undefined
  modeResetNotice: string | null
  creating: boolean
  onCreate: () => void
  onCancel: () => void
}) {
  return (
    <Card id="schedule-create-form" className="mb-4 p-4">
      <div className="space-y-3">
        <h3 className="text-sm font-medium">New scheduled scan</h3>
        <FormField label="Target" htmlFor="schedule-target">
          <Select
            id="schedule-target"
            autoFocus
            value={selectedTargetId}
            onChange={(e) => onTarget(e.target.value)}
          >
            <option value="">Select a target</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {scheduleTargetOptionLabel(target)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Frequency" htmlFor="frequency">
          <Select id="frequency" value={frequency} onChange={(e) => onFrequency(e.target.value)}>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="CUSTOM" disabled>
              Custom cron
            </option>
          </Select>
        </FormField>
        <div className="mt-1">
          <ScheduleAdvancedToggle open={showAdvanced} onClick={onToggleAdvanced} />
          {showAdvanced && (
            <div id="schedule-advanced" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Cron Expression" htmlFor="cron-expr">
                <Input
                  id="cron-expr"
                  type="text"
                  className="font-mono"
                  placeholder="0 0 * * 0"
                  value={cron}
                  onChange={(e) => onCron(e.target.value)}
                />
                <p className="text-muted-foreground mt-1 text-xs">{describeCron(cron)}</p>
              </FormField>
              <FormField label="Scan depth" htmlFor="scan-preset">
                <Select
                  id="scan-preset"
                  value={selectedOption?.id ?? ""}
                  onChange={(e) => onPreset(e.target.value)}
                >
                  {options.map((option) => (
                    <option
                      key={option.id}
                      value={option.id}
                      disabled={!option.available}
                      title={option.disabledReason}
                    >
                      {option.label}
                      {!option.available ? ` — ${option.disabledReason}` : ""}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          )}
        </div>
        {modeResetNotice && (
          <p className="text-foreground text-xs" role="status" aria-live="polite">
            {modeResetNotice}
          </p>
        )}
        {selectedTargetId && targetDetails?.type === "API" && (
          <p className="text-muted-foreground text-xs" role="status" aria-live="polite">
            Contract and Contract Behavior schedules require an OpenAPI document on the target.
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          {selectedOption?.description}{" "}
          {selectedTargetId && !usesEngine
            ? "This target uses deterministic scanners."
            : "A protected scan limit is applied automatically."}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={creating || !selectedTargetId}
            aria-busy={creating}
            onClick={onCreate}
          >
            {creating && <Spinner />}
            {creating ? "Creating schedule…" : "Create"}
          </Button>
          <Button size="sm" variant="ghost" disabled={creating} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
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
  const [targetsLoading, setTargetsLoading] = useState(true)
  const [targetsError, setTargetsError] = useState(false)
  const [targetsRetry, setTargetsRetry] = useState(0)
  const formTriggerRef = useRef<HTMLButtonElement>(null)
  const [selectedTargetId, setSelectedTargetId] = useState("")
  const [cron, setCron] = useState("0 0 * * 0")
  const [presetId, setPresetId] = useState("")
  const [creating, setCreating] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [frequency, setFrequency] = useState("WEEKLY")
  const [modeResetNotice, setModeResetNotice] = useState<string | null>(null)

  const selectedTargetDetails = targets.find((target) => target.id === selectedTargetId)
  const selectedTargetUsesEngine = selectedTargetDetails?.type === "REPO"
  const availableOptions = getManualScanOptions({
    type: selectedTargetDetails?.type ?? "",
    hasApiSpec: Boolean(selectedTargetDetails?.apiSpecUrl),
  })
  const enabledOptions = availableOptions.filter((o) => o.available)
  const selectedOption = enabledOptions.find((o) => o.id === presetId) ?? enabledOptions[0]

  function handleSelectTarget(targetId: string) {
    setSelectedTargetId(targetId)
    if (!targetId) {
      setPresetId("")
      setModeResetNotice(null)
      return
    }
    const nextTarget = targets.find((target) => target.id === targetId)
    const nextOptions = getManualScanOptions({
      type: nextTarget?.type ?? "",
      hasApiSpec: Boolean(nextTarget?.apiSpecUrl),
    }).filter((option) => option.available)
    const currentStillAvailable = nextOptions.find((o) => o.id === presetId)
    if (currentStillAvailable) {
      setModeResetNotice(null)
      return
    }
    const firstAvailable = nextOptions[0]
    if (firstAvailable) {
      setPresetId(firstAvailable.id)
      setModeResetNotice(
        presetId
          ? `Review depth reset to ${firstAvailable.label} because the previous choice is not available for this target.`
          : null
      )
    } else {
      setPresetId("")
      setModeResetNotice(null)
    }
  }

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

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    apiGetPaginated(`/api/targets`, { workspaceId }, { schema: targetOptionsPaginatedSchema })
      .then((res) => {
        if (cancelled) return
        setTargets(res.items)
      })
      .catch(() => {
        if (cancelled) return
        setTargetsError(true)
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId, targetsRetry])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      if (!selectedOption) {
        setError("No review option is available for this target")
        return
      }
      await apiPost(`/api/schedules`, {
        workspaceId,
        targetId: selectedTargetId,
        cron,
        goal: selectedOption.goal,
        mode: selectedOption.mode,
      })
      setShowCreateForm(false)
      setSelectedTargetId("")
      setCron("0 0 * * 0")
      setPresetId("")
      setFrequency("WEEKLY")
      setShowAdvanced(false)
      await loadSchedules()
      requestAnimationFrame(() => formTriggerRef.current?.focus())
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
      {schedules.length > 0 && targets.length > 0 && (
        <div className="mb-4 flex justify-end">
          <Button
            ref={formTriggerRef}
            size="sm"
            aria-expanded={showCreateForm}
            aria-controls="schedule-create-form"
            onClick={() => setShowCreateForm(!showCreateForm)}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            New Schedule
          </Button>
        </div>
      )}

      {showCreateForm && targets.length > 0 && (
        <ScheduleCreateForm
          targets={targets}
          selectedTargetId={selectedTargetId}
          onTarget={handleSelectTarget}
          frequency={frequency}
          onFrequency={(value) => {
            setFrequency(value)
            const cronMap: Record<string, string> = {
              DAILY: "0 0 * * *",
              WEEKLY: "0 0 * * 0",
              MONTHLY: "0 0 1 * *",
            }
            if (cronMap[value]) setCron(cronMap[value]!)
          }}
          cron={cron}
          onCron={(value) => {
            setCron(value)
            const reverseMap: Record<string, string> = {
              "0 0 * * *": "DAILY",
              "0 0 * * 0": "WEEKLY",
              "0 0 1 * *": "MONTHLY",
            }
            setFrequency(reverseMap[value.trim()] ?? "CUSTOM")
          }}
          showAdvanced={showAdvanced}
          onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
          options={availableOptions}
          selectedOption={selectedOption}
          onPreset={setPresetId}
          targetDetails={selectedTargetDetails}
          usesEngine={selectedTargetUsesEngine}
          modeResetNotice={modeResetNotice}
          creating={creating}
          onCreate={() => void handleCreate()}
          onCancel={() => {
            setShowCreateForm(false)
            requestAnimationFrame(() => formTriggerRef.current?.focus())
          }}
        />
      )}

      {error && (
        <DashboardErrorCard
          message={error}
          onRetry={() => {
            setError(null)
            void loadSchedules()
          }}
        />
      )}

      {targetsError && (
        <DashboardErrorCard
          message="Could not load targets for scheduling."
          onRetry={() => {
            setTargetsLoading(true)
            setTargetsError(false)
            setTargetsRetry((value) => value + 1)
          }}
        />
      )}

      {(loading || targetsLoading) && schedules.length === 0 ? (
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
      ) : (targetsError || error) && schedules.length === 0 ? null : schedules.length === 0 &&
        targets.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="Add a target to schedule scans"
          description="Scheduled scans need a target. Open Targets to add one, then return here to choose a schedule."
          action={
            <Link href="/dashboard/targets?add=1" className={buttonVariants()}>
              Manage targets
            </Link>
          }
        />
      ) : schedules.length === 0 && !showCreateForm ? (
        <EmptyState
          icon={Calendar}
          title="No scheduled scans"
          description="Set up recurring scans to monitor your targets on a schedule."
          action={
            <Button
              ref={formTriggerRef}
              aria-expanded={showCreateForm}
              aria-controls="schedule-create-form"
              onClick={() => setShowCreateForm(true)}
            >
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
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-medium">{schedule.target.name}</h3>
                    <Badge variant="info">{getGoalLabel(schedule.goal)}</Badge>
                    <Badge variant="muted">{modeLabel(schedule.mode)}</Badge>
                    <Badge variant={schedule.enabled ? "success" : "muted"}>
                      {schedule.enabled ? "active" : "disabled"}
                    </Badge>
                  </div>
                  <p className="text-sm">{describeCron(schedule.cron)}</p>
                  <p className="text-muted-foreground font-mono text-xs">{schedule.cron}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Created {formatDate(schedule.createdAt)}
                    {schedule.lastRunAt && <> · Last run {formatDateTimeUtc(schedule.lastRunAt)}</>}
                    {schedule.nextRunAt && <> · Next run {formatDateTimeUtc(schedule.nextRunAt)}</>}
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
