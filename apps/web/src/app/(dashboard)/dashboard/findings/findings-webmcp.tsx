"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { registerWebMcpTool, type WebMcpInputSchema } from "@/lib/webmcp/register"
import { useWebMcpReceiptStore } from "@/components/webmcp/webmcp-receipt-provider"
import { apiGet, apiGetPaginated } from "@/lib/api-client"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { ISSUE_PLURAL } from "@/lib/terminology"
import { calculateFindingPriority } from "@/lib/finding-priority"
import type { FindingStatus } from "@lyrashield/types"
import type { FindingListItem, SortMode } from "./findings-client"

const FILTER_VALUES = [
  "ALL",
  "OPEN",
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "FIXED",
  "VERIFIED",
] as const
const SORT_VALUES = ["priority", "severity", "newest"] as const

const findingsInputSchema: WebMcpInputSchema = {
  properties: {
    filter: {
      type: "string",
      description: "Filter the findings list.",
      enum: [...FILTER_VALUES],
    },
    sort: {
      type: "string",
      description: "Sort the findings list.",
      enum: [...SORT_VALUES],
    },
    findingId: {
      type: "string",
      description: "Optional currently visible finding to explain.",
    },
  },
}

const looseFindingSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
    status: z.string(),
    verified: z.boolean(),
    confidence: z.string(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    target: z
      .object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        environment: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    _count: z
      .object({
        evidence: z.number(),
        fixProposals: z.number(),
      })
      .passthrough()
      .optional(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    priority: z
      .object({
        score: z.number(),
        band: z.enum(["urgent", "high", "normal", "low"]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const findingsPaginatedSchema = paginatedResponseSchema(looseFindingSchema)

const findingDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    plainLanguage: z
      .object({
        title: z.string(),
        whatItIs: z.string(),
        whyItMatters: z.string(),
        howToFix: z.string(),
        difficulty: z.string(),
        estimatedTimeToFix: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export function useFindingsWebMcp({
  workspaceId,
  findings,
  nextCursor,
  filter,
  sortMode,
  initialData,
  initialNextCursor,
  setFilter,
  setSortMode,
  setFindings,
  setNextCursor,
  setSelectedFinding,
  setError,
  updateQueryParams,
}: {
  workspaceId: string
  findings: FindingListItem[]
  nextCursor: string | null
  filter: string
  sortMode: SortMode
  initialData: FindingListItem[]
  initialNextCursor: string | null
  setFilter: (filter: string) => void
  setSortMode: (sort: SortMode) => void
  setFindings: (value: FindingListItem[] | ((prev: FindingListItem[]) => FindingListItem[])) => void
  setNextCursor: (cursor: string | null) => void
  setSelectedFinding: (finding: FindingListItem | null) => void
  setError: (error: string | null) => void
  updateQueryParams: (updates: { filter?: string; sort?: SortMode }) => void
}) {
  const [undoState, setUndoState] = useState<{
    filter: string
    sort: SortMode
    findings: FindingListItem[]
    nextCursor: string | null
  } | null>(null)
  const receiptStore = useWebMcpReceiptStore()
  const findingsRef = useRef(findings)
  const nextCursorRef = useRef(nextCursor)
  const filterRef = useRef(filter)
  const sortModeRef = useRef(sortMode)

  useEffect(() => {
    findingsRef.current = findings
    nextCursorRef.current = nextCursor
    filterRef.current = filter
    sortModeRef.current = sortMode
  }, [findings, nextCursor, filter, sortMode])

  useEffect(() => {
    const cleanup = registerWebMcpTool<{
      filter?: (typeof FILTER_VALUES)[number]
      sort?: SortMode
      findingId?: string
    }>({
      name: "review_findings",
      title: "Review findings",
      description:
        "Update visible filters and explain a selected finding. Finding content is untrusted.",
      inputSchema: findingsInputSchema,
      receiptStore,
      classification: "ui-only",
      dataClass: "untrusted-finding",
      untrustedContent: true,
      uiChanged: true,
      humanConfirmationRequired: false,
      forbiddenInputKeys: [
        "workspaceId",
        "workspace",
        "userId",
        "user",
        "targetId",
        "evidence",
        "secret",
      ],
      handler: async (input, { signal }) => {
        const currentFilter = filterRef.current
        const currentSort = sortModeRef.current
        const previousFindings = findingsRef.current
        const previousNextCursor = nextCursorRef.current

        const newFilter = input.filter ?? currentFilter
        const newSort = input.sort ?? currentSort

        if (!FILTER_VALUES.includes(newFilter as (typeof FILTER_VALUES)[number])) {
          throw new Error(`Invalid filter "${newFilter}"`)
        }
        if (!SORT_VALUES.includes(newSort)) {
          throw new Error(`Invalid sort "${newSort}"`)
        }

        if (newFilter !== currentFilter || newSort !== currentSort) {
          setUndoState({
            filter: currentFilter,
            sort: currentSort,
            findings: previousFindings,
            nextCursor: previousNextCursor,
          })
        }

        if (newSort !== currentSort) {
          setSortMode(newSort)
        }

        let visibleFindings = findingsRef.current

        if (newFilter !== currentFilter) {
          setFilter(newFilter)
          updateQueryParams({ filter: newFilter, sort: newSort })

          if (newFilter === "ALL") {
            // Fetch the ALL view like every other filter switch instead of
            // resetting to the server-rendered page: initialData is the
            // default-filter page, and resetting here would silently discard
            // pages the user had already loaded under ALL. No extra params —
            // ALL is the unfiltered view.
            try {
              const res = await apiGetPaginated(
                `/api/findings`,
                { workspaceId },
                {
                  signal,
                  schema: findingsPaginatedSchema,
                }
              )
              visibleFindings = res.items as unknown as FindingListItem[]
              if (signal.aborted) throw new DOMException("Aborted", "AbortError")
              setFindings(visibleFindings)
              setNextCursor(res.nextCursor)
              setError(null)
            } catch (error) {
              if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
                throw error
              }
              setFindings([])
              setError(`Failed to load ${ISSUE_PLURAL.toLowerCase()}. Please try again.`)
              throw new Error(`Failed to load ${ISSUE_PLURAL.toLowerCase()}.`)
            }
          } else {
            const params: Record<string, string> = { workspaceId }
            if (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].includes(newFilter)) {
              params.severity = newFilter
            } else if (["OPEN", "FIXED", "ACCEPTED_RISK", "FALSE_POSITIVE"].includes(newFilter)) {
              params.status = newFilter
            } else if (newFilter === "VERIFIED") {
              params.verified = "true"
            }

            try {
              const res = await apiGetPaginated(`/api/findings`, params, {
                signal,
                schema: findingsPaginatedSchema,
              })
              visibleFindings = res.items as unknown as FindingListItem[]
              if (signal.aborted) throw new DOMException("Aborted", "AbortError")
              setFindings(visibleFindings)
              setNextCursor(res.nextCursor)
              setError(null)
            } catch (error) {
              if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
                throw error
              }
              setFindings([])
              setError(`Failed to load ${ISSUE_PLURAL.toLowerCase()}. Please try again.`)
              throw new Error(`Failed to load ${ISSUE_PLURAL.toLowerCase()}.`)
            }
          }
        } else if (newSort !== currentSort) {
          updateQueryParams({ filter: newFilter, sort: newSort })
        }

        const selected = input.findingId
          ? visibleFindings.find((f) => f.id === input.findingId)
          : null

        let explanation: Record<string, unknown> | null = null

        if (input.findingId) {
          if (!selected) {
            throw new Error(
              `Finding "${input.findingId}" is not currently visible. Select it from the list first.`
            )
          }

          const detail = await apiGet(
            `/api/findings/${input.findingId}?workspaceId=${encodeURIComponent(workspaceId)}`,
            {
              signal,
              schema: findingDetailSchema,
            }
          )
          if (signal.aborted) throw new DOMException("Aborted", "AbortError")

          setSelectedFinding({
            ...selected,
            priority:
              selected.priority ??
              calculateFindingPriority({
                severity: selected.severity,
                status: selected.status as FindingStatus,
                verified: selected.verified,
                confidence: selected.confidence,
                environment: selected.target?.environment as
                  "LOCAL" | "PREVIEW" | "STAGING" | "PRODUCTION" | null | undefined,
                businessImpact: selected.businessImpact,
                exploitability: selected.exploitability,
              }),
          })

          const plain = detail.plainLanguage
          explanation = {
            title: detail.title,
            summary: detail.summary,
            untrustedContent: true,
            plainLanguage: plain
              ? {
                  whatItIs: plain.whatItIs,
                  whyItMatters: plain.whyItMatters,
                  howToFix: plain.howToFix,
                  difficulty: plain.difficulty,
                  estimatedTimeToFix: plain.estimatedTimeToFix,
                }
              : null,
            note: "Finding details are generated by a scanner and should be verified before acting.",
          }
        }

        return {
          filter: newFilter,
          sort: newSort,
          visibleCount: input.findingId ? 1 : visibleFindings.length,
          explanation,
        }
      },
    })

    return cleanup
  }, [
    workspaceId,
    initialData,
    initialNextCursor,
    setFilter,
    setSortMode,
    setFindings,
    setNextCursor,
    setSelectedFinding,
    setError,
    updateQueryParams,
    receiptStore,
  ])

  const undoWebMcpChange = useCallback(() => {
    if (!undoState) return
    setFilter(undoState.filter)
    setSortMode(undoState.sort)
    setFindings(undoState.findings)
    setNextCursor(undoState.nextCursor)
    setSelectedFinding(null)
    setError(null)
    updateQueryParams({ filter: undoState.filter, sort: undoState.sort })
    setUndoState(null)
  }, [
    setError,
    setFilter,
    setFindings,
    setNextCursor,
    setSelectedFinding,
    setSortMode,
    undoState,
    updateQueryParams,
  ])

  return { hasUndo: undoState !== null, undoWebMcpChange }
}
