"use client"

import { useEffect, type MutableRefObject } from "react"
import { findingsPaginatedSchema } from "@/lib/api-schemas"
import { apiGetPaginated } from "@/lib/api-client"
import {
  findingFilterToApiQuery,
  parseFindingListParams,
  type FindingFilter as FindingFilterValue,
} from "@/lib/finding-list-params"
import type { FindingListItem, SortMode } from "./findings-list-model"
import {
  findingsContextKey,
  loadFindingsListContext,
  saveFindingsListContext,
  type FindingsListPage,
} from "./findings-list-context"

/**
 * The three list-scope effects of the findings page: restoring saved pages on
 * mount, saving the current page under its own scope key, and following
 * Back/Forward. They were inline in FindingsClient and moved here unchanged so
 * that component stays inside the size ratchet. Same guards, same dependency
 * arrays, same ordering — the restore effect still runs once per mount with the
 * URL-derived context and the save effect still refuses to save a previous
 * query's rows under a newly selected key.
 */
export interface FindingsRestoreParams {
  workspaceId: string
  initialData: FindingListItem[]
  initialNextCursor: string | null
  initialFilter: string
  initialSort: SortMode
  initialScanId: string
  initialTargetFilter: string
  initialQuery: string
  setFindings: (items: FindingListItem[]) => void
  setNextCursor: (cursor: string | null) => void
  setRestoreError: (value: boolean) => void
  setRestoreReady: (value: boolean) => void
  pagesRef: MutableRefObject<FindingsListPage[]>
  requestGenerationRef: MutableRefObject<number>
  restoreAbortRef: MutableRefObject<AbortController | null>
}

/** Server props own page one. Saved pages only tell us how many additional
 * pages to re-fetch through fresh cursors before restoring scroll. */
export function useFindingsListRestore({
  workspaceId,
  initialData,
  initialNextCursor,
  initialFilter,
  initialSort,
  initialScanId,
  initialTargetFilter,
  initialQuery,
  setFindings,
  setNextCursor,
  setRestoreError,
  setRestoreReady,
  pagesRef,
  requestGenerationRef,
  restoreAbortRef,
}: FindingsRestoreParams) {
  useEffect(() => {
    const abort = new AbortController()
    restoreAbortRef.current = abort
    queueMicrotask(() => {
      void (async () => {
        try {
          const stored = loadFindingsListContext(
            findingsContextKey(workspaceId, {
              filter: initialFilter,
              sort: initialSort,
              scanId: initialScanId,
              target: initialTargetFilter,
              q: initialQuery,
            })
          )
          if (!stored) return
          const restoreScroll = () => {
            if (stored.scrollY > 0)
              requestAnimationFrame(() => {
                if (!abort.signal.aborted && requestGenerationRef.current === 0)
                  window.scrollTo(0, stored.scrollY)
              })
          }
          if (stored.pages.length < 2 || !initialNextCursor) {
            restoreScroll()
            return
          }
          const pages: FindingsListPage[] = [{ items: initialData, nextCursor: initialNextCursor }]
          let cursor: string | null = initialNextCursor
          for (let index = 1; index < stored.pages.length && cursor; index++) {
            const result: FindingsListPage = await apiGetPaginated<FindingListItem>(
              "/api/findings",
              {
                workspaceId,
                ...findingFilterToApiQuery(initialFilter as FindingFilterValue),
                ...(initialScanId ? { observedInScanId: initialScanId } : {}),
                ...(initialTargetFilter ? { targetId: initialTargetFilter } : {}),
                ...(initialQuery ? { q: initialQuery } : {}),
                cursor,
              },
              { schema: findingsPaginatedSchema, signal: abort.signal }
            )
            if (abort.signal.aborted || requestGenerationRef.current !== 0) return
            if (!result.items.length) break
            if (
              pages.reduce((count, page) => count + page.items.length, 0) + result.items.length >
              500
            )
              break
            pages.push(result)
            cursor = result.nextCursor
          }
          if (abort.signal.aborted || requestGenerationRef.current !== 0) return
          pagesRef.current = pages
          setFindings(pages.flatMap((page) => page.items))
          setNextCursor(cursor)
          restoreScroll()
        } catch {
          if (!abort.signal.aborted) setRestoreError(true)
        } finally {
          if (!abort.signal.aborted) setRestoreReady(true)
        }
      })()
    })
    return () => abort.abort()
    // Restore once per mount with the URL-derived context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export interface FindingsSaveParams {
  workspaceId: string
  filter: string
  sortMode: SortMode
  scanId: string
  targetFilter: string
  query: string
  findings: FindingListItem[]
  nextCursor: string | null
  restoreReady: boolean
  pagesRef: MutableRefObject<FindingsListPage[]>
  loadedScopeRef: MutableRefObject<string>
  currentScopeRef: MutableRefObject<string>
}

/** Never save the previous query's rows under a newly selected query key. */
export function useFindingsListSave({
  workspaceId,
  filter,
  sortMode,
  scanId,
  targetFilter,
  query,
  findings,
  nextCursor,
  restoreReady,
  pagesRef,
  loadedScopeRef,
  currentScopeRef,
}: FindingsSaveParams) {
  useEffect(() => {
    if (
      !restoreReady ||
      loadedScopeRef.current !== currentScopeRef.current ||
      typeof window === "undefined"
    )
      return
    const save = () =>
      saveFindingsListContext(
        findingsContextKey(workspaceId, {
          filter,
          sort: sortMode,
          scanId,
          target: targetFilter,
          q: query,
        }),
        { pages: pagesRef.current, scrollY: window.scrollY }
      )
    save()
    window.addEventListener("pagehide", save)
    return () => window.removeEventListener("pagehide", save)
    // The scope refs are stable identities that never change, so they are not
    // dependencies: the query identity alone decides when this effect re-runs.
    // They arrive as hook parameters, which the rule cannot recognise as refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceId,
    filter,
    sortMode,
    scanId,
    targetFilter,
    query,
    findings,
    nextCursor,
    restoreReady,
  ])
}

export interface FindingsPopStateParams {
  workspaceId: string
  filter: string
  sortMode: SortMode
  scanId: string
  targetFilter: string
  query: string
  setFindings: (items: FindingListItem[]) => void
  setNextCursor: (cursor: string | null) => void
  setFilter: (value: string) => void
  setSortMode: (value: SortMode) => void
  setScanId: (value: string) => void
  setTargetFilter: (value: string) => void
  setQuery: (value: string) => void
  setLoading: (value: boolean) => void
  setError: (value: string | null) => void
  pagesRef: MutableRefObject<FindingsListPage[]>
  loadedScopeRef: MutableRefObject<string>
  currentScopeRef: MutableRefObject<string>
  invalidateRequest: () => number
  fetchFindings: (params: Record<string, string>, generation: number) => Promise<void>
  clearFindingForScopeChange: () => void
}

/** Follow Back/Forward: parse the URL and fetch its already-parsed query. */
export function useFindingsListPopState({
  workspaceId,
  filter,
  sortMode,
  scanId,
  targetFilter,
  query,
  setFindings,
  setNextCursor,
  setFilter,
  setSortMode,
  setScanId,
  setTargetFilter,
  setQuery,
  setLoading,
  setError,
  pagesRef,
  loadedScopeRef,
  currentScopeRef,
  invalidateRequest,
  fetchFindings,
  clearFindingForScopeChange,
}: FindingsPopStateParams) {
  useEffect(() => {
    const onPopState = () => {
      const parsed = parseFindingListParams(
        Object.fromEntries(new URLSearchParams(window.location.search))
      )
      const scopeChanged = parsed.scanId !== scanId || parsed.target !== targetFilter
      if (parsed.scopeValid && !scopeChanged && parsed.filter === filter && parsed.q === query) {
        if (parsed.sort !== sortMode) setSortMode(parsed.sort)
        return
      }
      currentScopeRef.current = JSON.stringify({
        filter: parsed.filter,
        scanId: parsed.scanId,
        target: parsed.target,
        q: parsed.q,
      })
      const generation = invalidateRequest()
      if (scopeChanged) clearFindingForScopeChange()
      setFilter(parsed.filter)
      setSortMode(parsed.sort)
      setScanId(parsed.scanId)
      setTargetFilter(parsed.target)
      setQuery(parsed.q)
      if (!parsed.scopeValid) {
        pagesRef.current = []
        loadedScopeRef.current = ""
        setFindings([])
        setNextCursor(null)
        setLoading(false)
        setError(
          "Selected scan or target is unavailable in this workspace. Clear the scope to continue."
        )
        return
      }
      void fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(parsed.filter),
          ...(parsed.scanId ? { observedInScanId: parsed.scanId } : {}),
          ...(parsed.target ? { targetId: parsed.target } : {}),
          ...(parsed.q ? { q: parsed.q } : {}),
        },
        generation
      )
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
    // Follow Back/Forward with the state the listener closes over. The scope
    // refs and the state setters are stable, so the parsed query identity alone
    // decides when the listener is rebuilt. Same documented exception the
    // inline effect carried in FindingsClient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceId,
    filter,
    sortMode,
    scanId,
    targetFilter,
    query,
    invalidateRequest,
    fetchFindings,
    clearFindingForScopeChange,
  ])
}
