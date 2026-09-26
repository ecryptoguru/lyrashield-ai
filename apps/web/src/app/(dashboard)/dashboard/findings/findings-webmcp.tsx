"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { registerWebMcpTool } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import type { FindingListItem, SortMode } from "./findings-client"
import {
  createReviewFindingsTool,
  runFindingsWebMcpUndo,
  type FindingsWebMcpUndoState,
} from "./findings-webmcp.utils"

export function useFindingsWebMcp({
  workspaceId,
  findings,
  filter,
  sortMode,
  setSortMode,
  setSelectedFinding,
  updateQueryParams,
  applyFilter,
}: {
  workspaceId: string
  findings: FindingListItem[]
  filter: string
  sortMode: SortMode
  setSortMode: (sort: SortMode) => void
  setSelectedFinding: (finding: FindingListItem | null) => void
  updateQueryParams: (updates: { filter?: string; sort?: SortMode }) => void
  applyFilter: (filter: string, sort: SortMode, signal?: AbortSignal) => Promise<FindingListItem[]>
}) {
  const [undoState, setUndoState] = useState<FindingsWebMcpUndoState | null>(null)
  const receiptStore = useWebMcpReceiptStore()
  const findingsRef = useRef(findings)
  const filterRef = useRef(filter)
  const sortModeRef = useRef(sortMode)

  useEffect(() => {
    findingsRef.current = findings
    filterRef.current = filter
    sortModeRef.current = sortMode
  }, [findings, filter, sortMode])

  useEffect(() => {
    const cleanup = registerWebMcpTool({
      ...createReviewFindingsTool({
        workspaceId,
        getFindings: () => findingsRef.current,
        getFilter: () => filterRef.current,
        getSortMode: () => sortModeRef.current,
        setSortMode,
        setSelectedFinding,
        updateQueryParams,
        applyFilter,
        setUndoState,
      }),
      receiptStore,
    })

    return cleanup
  }, [workspaceId, setSortMode, setSelectedFinding, updateQueryParams, applyFilter, receiptStore])

  const undoWebMcpChange = useCallback(() => {
    void runFindingsWebMcpUndo(undoState, {
      getFilter: () => filterRef.current,
      setSortMode,
      setSelectedFinding,
      updateQueryParams,
      applyFilter,
      setUndoState,
    }).catch(() => {
      // The shared list transition displays the retry state.
    })
  }, [applyFilter, setSelectedFinding, setSortMode, undoState, updateQueryParams])

  return { hasUndo: undoState !== null, undoWebMcpChange }
}
