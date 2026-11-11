"use client"

import { useRef, useState, type Dispatch, type SetStateAction } from "react"
import { apiPost } from "@/lib/api-client"
import { reportRevokeSchema, reportShareSchema, type ReportItem } from "./reports-model"

export function useReportShareActions({
  workspaceId,
  reports,
  setReports,
  isWorkspaceCurrent,
}: {
  workspaceId: string
  reports: ReportItem[]
  setReports: Dispatch<SetStateAction<ReportItem[]>>
  isWorkspaceCurrent: (workspaceId: string) => boolean
}) {
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [sharedReportId, setSharedReportId] = useState<string | null>(null)
  const [copied, setCopied] = useState<"link" | "handoff" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [packetActionsPending, setPacketActionsPending] = useState<Set<string>>(new Set())
  const reportMutationVersionsRef = useRef(new Map<string, number>())
  const packetActionsPendingRef = useRef(new Set<string>())

  const handleShare = async (reportId: string) => {
    const isPacket = reports.some(
      (report) => report.id === reportId && report.type === "release_packet"
    )
    const mutationKey = `${workspaceId}:${reportId}`
    if (isPacket && packetActionsPendingRef.current.has(mutationKey)) return
    if (isPacket) {
      packetActionsPendingRef.current.add(mutationKey)
      setPacketActionsPending(new Set(packetActionsPendingRef.current))
    }
    const mutationVersion = (reportMutationVersionsRef.current.get(mutationKey) ?? 0) + 1
    reportMutationVersionsRef.current.set(mutationKey, mutationVersion)
    try {
      const res = await apiPost(
        isPacket
          ? `/api/reports/release-packet/${encodeURIComponent(reportId)}`
          : `/api/reports/${reportId}`,
        { workspaceId, action: "share" },
        { schema: reportShareSchema }
      )
      if (
        !isWorkspaceCurrent(workspaceId) ||
        reportMutationVersionsRef.current.get(mutationKey) !== mutationVersion
      ) {
        return
      }
      const fullUrl = `${window.location.origin}${res.shareUrl}`
      setShareUrl(fullUrl)
      setSharedReportId(reportId)
      setCopied(null)
      setActionError(null)
      setReports((current) =>
        current.map((report) =>
          report.id === reportId
            ? { ...report, shareExpiresAt: res.expiresAt, ...(isPacket ? { revokedAt: null } : {}) }
            : report
        )
      )
    } catch (error) {
      if (isWorkspaceCurrent(workspaceId)) {
        setActionError(error instanceof Error ? error.message : "Failed to generate share link.")
      }
    } finally {
      if (isPacket) {
        packetActionsPendingRef.current.delete(mutationKey)
        if (isWorkspaceCurrent(workspaceId))
          setPacketActionsPending(new Set(packetActionsPendingRef.current))
      }
    }
  }

  const handleRevoke = async (reportId: string) => {
    const isPacket = reports.some(
      (report) => report.id === reportId && report.type === "release_packet"
    )
    const mutationKey = `${workspaceId}:${reportId}`
    if (isPacket && packetActionsPendingRef.current.has(mutationKey)) return
    if (isPacket) {
      packetActionsPendingRef.current.add(mutationKey)
      setPacketActionsPending(new Set(packetActionsPendingRef.current))
    }
    const mutationVersion = (reportMutationVersionsRef.current.get(mutationKey) ?? 0) + 1
    reportMutationVersionsRef.current.set(mutationKey, mutationVersion)
    try {
      const result = await apiPost(
        isPacket
          ? `/api/reports/release-packet/${encodeURIComponent(reportId)}`
          : `/api/reports/${reportId}`,
        { workspaceId, action: "revoke" },
        { schema: reportRevokeSchema }
      )
      if (
        !isWorkspaceCurrent(workspaceId) ||
        reportMutationVersionsRef.current.get(mutationKey) !== mutationVersion
      ) {
        return
      }
      setReports((current) =>
        current.map((report) =>
          report.id === reportId ? { ...report, revokedAt: result.revokedAt } : report
        )
      )
      if (sharedReportId === reportId) {
        setShareUrl(null)
        setSharedReportId(null)
        setCopied(null)
      }
      setActionError(null)
    } catch (error) {
      if (isWorkspaceCurrent(workspaceId)) {
        setActionError(error instanceof Error ? error.message : "Failed to revoke share link.")
      }
    } finally {
      if (isPacket) {
        packetActionsPendingRef.current.delete(mutationKey)
        if (isWorkspaceCurrent(workspaceId))
          setPacketActionsPending(new Set(packetActionsPendingRef.current))
      }
    }
  }

  return {
    shareUrl,
    sharedReportId,
    copied,
    setCopied,
    actionError,
    setActionError,
    packetActionsPending,
    handleShare,
    handleRevoke,
  }
}
