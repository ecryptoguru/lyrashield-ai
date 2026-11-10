import { useCallback, useEffect, useState } from "react"
import {
  SETUP_HEALTH_TTL_MS,
  SetupHealthSnapshotSchema,
  type SetupHealthSnapshot,
} from "@lyrashield/types"
import { apiGet } from "@/lib/api-client"

interface SetupRequest {
  workspaceId: string
  targetId: string
  actorId: string
  goal: string
  mode: string
  workflow: "REVIEW_TARGET" | "REVIEW_CHANGES" | "AUTHENTICATED_ASSESSMENT"
}

interface SnapshotRecord {
  requestKey: string
  value: SetupHealthSnapshot
  deadline: number
}

export function useTargetSetupHealth({
  workspaceId,
  targetId,
  actorId,
  goal,
  mode,
  workflow,
}: SetupRequest) {
  const [record, setRecord] = useState<SnapshotRecord | null>(null)
  const [completedRequestKey, setCompletedRequestKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const requestKey = JSON.stringify([attempt, workspaceId, targetId, actorId, goal, mode, workflow])

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = performance.now()
    let cancelled = false
    const params = new URLSearchParams({ workspaceId, targetId, goal, mode, workflow })
    apiGet(`/api/v1/setup-health?${params.toString()}`, {
      schema: SetupHealthSnapshotSchema,
      signal: controller.signal,
    })
      .then((result) => {
        if (cancelled || !result) return
        const now = performance.now()
        const remaining = Date.parse(result.expiresAt) - Date.now()
        const deadline = Math.min(startedAt + SETUP_HEALTH_TTL_MS, now + remaining)
        if (!Number.isFinite(deadline) || deadline <= now) {
          setRecord(null)
          setError("Setup status expired. Retry the check.")
          return
        }
        setRecord({ requestKey, value: result, deadline })
        setError(null)
      })
      .catch((cause) => {
        if (!cancelled && !controller.signal.aborted) {
          setRecord(null)
          setError(cause instanceof Error ? cause.message : "Setup health is unavailable")
        }
      })
      .finally(() => {
        if (!cancelled) setCompletedRequestKey(requestKey)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [goal, mode, requestKey, targetId, workflow, workspaceId])

  useEffect(() => {
    if (!record || record.requestKey !== requestKey) return
    const timer = setTimeout(
      () => setAttempt((value) => value + 1),
      Math.max(0, record.deadline - performance.now())
    )
    return () => clearTimeout(timer)
  }, [record, requestKey])

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") setAttempt((value) => value + 1)
    }
    document.addEventListener("visibilitychange", refreshWhenVisible)
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible)
  }, [])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const snapshot = record?.requestKey === requestKey ? record.value : null
  return { snapshot, loading: completedRequestKey !== requestKey, error, retry }
}
