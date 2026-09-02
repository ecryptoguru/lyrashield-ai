"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Activity, CheckCircle2, X, XCircle, AlertTriangle, Loader2, History } from "lucide-react"
import { Button, Badge, Card } from "@lyrashield/ui"
import { useWebMcpReceiptStore } from "./webmcp-receipt-provider"
import { cn } from "@lyrashield/ui"
import type { WebMcpActivityReceipt } from "@/lib/webmcp/receipts"

const STATUS_CONFIG: Record<
  WebMcpActivityReceipt["status"],
  {
    label: string
    icon: typeof Activity
    variant: "default" | "success" | "danger" | "warning" | "muted"
  }
> = {
  running: { label: "Running", icon: Loader2, variant: "warning" },
  completed: { label: "Done", icon: CheckCircle2, variant: "success" },
  cancelled: { label: "Cancelled", icon: XCircle, variant: "warning" },
  failed: { label: "Failed", icon: AlertTriangle, variant: "danger" },
}

const CLASSIFICATION_LABEL: Record<WebMcpActivityReceipt["classification"], string> = {
  read: "Read",
  "ui-only": "UI only",
  "mutation-prepared": "Prepared mutation",
}

const DATA_CLASS_LABEL: Record<WebMcpActivityReceipt["dataClass"], string> = {
  public: "Public",
  "workspace-summary": "Workspace",
  "untrusted-finding": "Untrusted finding",
  "source-local": "Local source",
}

export function WebMcpActivityDrawer() {
  const store = useWebMcpReceiptStore()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const subscribe = useCallback((callback: () => void) => store.subscribe(callback), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!isOpen) return
    const trigger = triggerRef.current
    closeRef.current?.focus()
    return () => trigger?.focus()
  }, [isOpen])

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      setIsOpen(false)
      return
    }
    // Non-modal panel: Tab may leave it; the page remains interactive.
  }, [])

  const { receipts, latest } = snapshot

  if (receipts.length === 0) {
    return null
  }

  const latestRunning = receipts.find((r) => r.status === "running") ?? null
  const status = latest ? STATUS_CONFIG[latest.status] : STATUS_CONFIG.completed
  const StatusIcon = status.icon

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col items-end gap-2 md:bottom-6 sm:right-6">
      {/* Live region for running work; completed history is not re-announced. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {latestRunning
          ? `Agent activity: ${latestRunning.toolName} is ${latestRunning.status}`
          : ""}
      </div>

      {/* Compact latest-status chip */}
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="webmcp-activity-panel"
        aria-label={`Agent activity: ${latest?.toolName ?? ""} ${latest?.status ?? ""}`}
        className={cn(
          "shadow-card-hover border-border/80 bg-background/95 backdrop-blur-sm",
          isOpen && "ring-ring ring-2"
        )}
      >
        <StatusIcon
          className={cn("mr-1.5 h-4 w-4", latest?.status === "running" && "animate-spin")}
          aria-hidden="true"
        />
        <span className="max-w-40 truncate">{latest?.toolName ?? "Agent"}</span>
        <Badge variant={status.variant} className="ml-2 text-[10px] uppercase tracking-wide">
          {status.label}
        </Badge>
      </Button>

      {/* Expandable, mobile-safe panel */}
      {isOpen && (
        <Card
          ref={panelRef}
          id="webmcp-activity-panel"
          className={cn(
            "shadow-card-hover w-[calc(100vw-2rem)] max-w-sm overflow-hidden border",
            "fixed bottom-32 right-4 md:bottom-[4.5rem] sm:right-6"
          )}
          role="dialog"
          aria-label="Agent activity history"
          onKeyDown={handlePanelKeyDown}
        >
          <div className="border-b p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Agent activity</h2>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsOpen(false)
                    store.clear()
                  }}
                  aria-label="Clear activity history"
                >
                  <History className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  ref={closeRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close activity panel"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Last {receipts.length} current-tab actions. History clears on reload and sign-out.
            </p>
          </div>

          <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
            <ul className="space-y-2" role="list" aria-label="Activity receipts">
              {receipts.map((receipt) => {
                const config = STATUS_CONFIG[receipt.status]
                const Icon = config.icon
                return (
                  <li
                    key={receipt.id}
                    className="bg-muted/40 hover:bg-muted/60 rounded-lg border p-2.5 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant={config.variant} className="text-[10px]">
                            <Icon
                              className={cn(
                                "mr-1 h-3 w-3",
                                receipt.status === "running" && "animate-spin"
                              )}
                              aria-hidden="true"
                            />
                            {config.label}
                          </Badge>
                          <Badge variant="muted" className="text-[10px]">
                            {CLASSIFICATION_LABEL[receipt.classification]}
                          </Badge>
                          {receipt.untrustedContent && (
                            <Badge variant="warning" className="text-[10px]">
                              Untrusted
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-sm font-medium" title={receipt.toolName}>
                          {receipt.toolName}
                        </p>
                        <p className="text-muted-foreground line-clamp-2 text-xs">
                          {receipt.summary}
                        </p>
                        <p className="text-muted-foreground mt-1 text-[10px]">
                          {DATA_CLASS_LABEL[receipt.dataClass]}
                          {receipt.humanConfirmationRequired && " · confirmation required"}
                        </p>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </Card>
      )}
    </div>
  )
}
