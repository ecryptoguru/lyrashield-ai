"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { apiGet, ApiError } from "@/lib/api-client"

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

export const apiKeyRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    lastUsedAt: z.string().datetime().or(z.string()).nullable(),
    expiresAt: z.string().datetime().or(z.string()).nullable(),
    revokedAt: z.string().datetime().or(z.string()).nullable(),
    createdAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const apiKeysSchema = z.array(apiKeyRowSchema)

const expirySchema = z.string().datetime({ offset: true })

export function expiryTime(value: string | null): number | null {
  if (!value || !expirySchema.safeParse(value).success) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function useApiKeysList(workspaceId: string, canManage: boolean) {
  const listRequest = useRef(0)
  const mounted = useRef(false)
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null)
  const [loadingKeys, setLoadingKeys] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [now, setNow] = useState<number | null>(null)

  const load = useCallback(async () => {
    const requestId = ++listRequest.current
    setLoadingKeys(true)
    try {
      const data = await apiGet<ApiKeyRow[]>(`/api/api-keys?workspaceId=${workspaceId}`, {
        schema: apiKeysSchema,
      })
      if (requestId !== listRequest.current) return
      setKeys(data)
      setListError(null)
    } catch (err) {
      if (requestId !== listRequest.current) return
      setListError(err instanceof ApiError ? err.message : "Failed to load API keys")
    } finally {
      if (requestId === listRequest.current) setLoadingKeys(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!canManage) return
    mounted.current = true
    // A workspace change starts a fresh read and sets its loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return () => {
      mounted.current = false
      listRequest.current += 1
    }
  }, [canManage, load])

  useEffect(() => {
    const updateNow = () => setNow(Date.now())
    updateNow()
    window.addEventListener("focus", updateNow)
    document.addEventListener("visibilitychange", updateNow)
    return () => {
      window.removeEventListener("focus", updateNow)
      document.removeEventListener("visibilitychange", updateNow)
    }
  }, [])

  useEffect(() => {
    if (now === null || !keys) return
    const next = keys
      .map((key) => expiryTime(key.expiresAt))
      .filter((time): time is number => time !== null && time > now)
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(next - now + 5, 2_147_483_647)
    )
    return () => window.clearTimeout(timer)
  }, [keys, now])

  return { keys, loadingKeys, listError, now, load, mounted }
}
