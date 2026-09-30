"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FindingListItem } from "./findings-client"

export function useFindingDrawer(
  findings: FindingListItem[],
  initialData: FindingListItem[],
  initialSelectedFindingId?: string
) {
  const [selectedFinding, setSelectedFinding] = useState<FindingListItem | null>(() =>
    initialSelectedFindingId
      ? (initialData.find((finding) => finding.id === initialSelectedFindingId) ?? null)
      : null
  )
  // The row that opened the drawer, for focus restoration on close.
  const openerRef = useRef<HTMLElement | null>(null)
  const pushedFindingUrlRef = useRef(false)

  /**
   * Drawer URL state: opening writes `finding=` (pushState, so Back returns to
   * the list), closing removes only `finding=` and restores focus to the row
   * that opened the drawer. Filter/sort/search state is never touched.
   */
  const openFinding = useCallback((finding: FindingListItem) => {
    setSelectedFinding(finding)
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    url.searchParams.set("finding", finding.id)
    window.history.pushState(null, "", `${url.pathname}${url.search}`)
    pushedFindingUrlRef.current = true
  }, [])

  const closeFinding = useCallback(() => {
    const opener = openerRef.current
    setSelectedFinding(null)
    openerRef.current = null
    if (typeof window === "undefined") return
    if (pushedFindingUrlRef.current) {
      pushedFindingUrlRef.current = false
      // Back pops the pushed entry; the popstate listener keeps state in sync.
      window.history.back()
    } else {
      const url = new URL(window.location.href)
      url.searchParams.delete("finding")
      window.history.replaceState(null, "", `${url.pathname}${url.search}`)
    }
    // Restore focus to the row that opened the drawer.
    requestAnimationFrame(() => opener?.focus())
  }, [])

  const clearFindingForScopeChange = useCallback(() => {
    setSelectedFinding(null)
    openerRef.current = null
    pushedFindingUrlRef.current = false
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    url.searchParams.delete("finding")
    window.history.replaceState(null, "", `${url.pathname}${url.search}`)
  }, [])

  // Browser Back from a drawer deep link or an opened drawer returns to the
  // list state without losing filter/sort/search.
  useEffect(() => {
    const onPopState = () => {
      pushedFindingUrlRef.current = false
      const findingId = new URL(window.location.href).searchParams.get("finding")
      setSelectedFinding(
        findingId ? (findings.find((finding) => finding.id === findingId) ?? null) : null
      )
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [findings])

  // Keep the drawer deep link on refresh. closeFinding removes it explicitly.

  return {
    selectedFinding,
    setSelectedFinding,
    openerRef,
    openFinding,
    closeFinding,
    clearFindingForScopeChange,
  }
}
