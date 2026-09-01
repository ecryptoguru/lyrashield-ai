"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { FileText } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  buttonVariants,
} from "@lyrashield/ui"
import type { PublicControlEvidenceItem } from "@/lib/ai-assurance"
import { apiPost } from "@/lib/api-client"
import { AssuranceInventory, type AssuranceInventoryProps } from "./assurance-inventory"

interface TargetOption {
  id: string
  name: string
}

interface AiAssuranceClientProps {
  workspaceId: string
  targetId: string | null
  targets: TargetOption[]
  initialItems: PublicControlEvidenceItem[]
  canManage: boolean
  canReview: boolean
  initialProfile: AssuranceInventoryProps["initialProfile"]
  initialThreatModel: AssuranceInventoryProps["initialThreatModel"]
}

const STATE_BADGE: Record<string, { label: string; className: string }> = {
  EVIDENCE_REQUIRED: { label: "Required", className: "bg-muted text-muted-foreground" },
  EVIDENCE_SUBMITTED: {
    label: "Submitted",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100",
  },
  EVIDENCE_ACCEPTED: {
    label: "Accepted",
    className: "bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-100",
  },
  EVIDENCE_EXPIRED: {
    label: "Expired",
    className: "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-100",
  },
  NOT_APPLICABLE: {
    label: "Not applicable",
    className: "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
  },
}

export function AiAssuranceClient({
  workspaceId,
  targetId,
  targets,
  initialItems,
  canManage,
  canReview,
  initialProfile,
  initialThreatModel,
}: AiAssuranceClientProps) {
  const [items, setItems] = useState<PublicControlEvidenceItem[]>(initialItems)
  const [editingControlId, setEditingControlId] = useState<string | null>(null)
  const [pendingControlId, setPendingControlId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const acceptedCount = items.filter((item) => item.state === "EVIDENCE_ACCEPTED").length
  const submittedCount = items.filter((item) => item.state === "EVIDENCE_SUBMITTED").length
  const requiredCount = items.filter((item) => item.state === "EVIDENCE_REQUIRED").length

  function replaceItem(next: PublicControlEvidenceItem) {
    setItems((current) => current.map((item) => (item.controlId === next.controlId ? next : item)))
  }

  async function readItem(response: Response): Promise<PublicControlEvidenceItem> {
    let body: { data?: PublicControlEvidenceItem; error?: { message?: string } }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new Error("The artifact upload returned an invalid response")
    }
    if (!response.ok || !body.data) {
      throw new Error(body.error?.message ?? "The evidence update failed")
    }
    return body.data
  }

  async function saveAttestation(item: PublicControlEvidenceItem, formData: FormData) {
    setPendingControlId(item.controlId)
    setError(null)
    try {
      const attestation = String(formData.get("attestation") ?? "").trim()
      const expiry = String(formData.get("expiresAt") ?? "")
      const body = {
        workspaceId,
        ...(item.evidenceId ? {} : { targetId, controlId: item.controlId }),
        attestation,
        expiresAt: expiry ? new Date(`${expiry}T00:00:00.000Z`).toISOString() : null,
      }
      const endpoint = item.evidenceId
        ? `/api/ai-assurance/evidence/${encodeURIComponent(item.evidenceId)}/revise`
        : "/api/ai-assurance/evidence"
      replaceItem(await apiPost<PublicControlEvidenceItem>(endpoint, body))
      setEditingControlId(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The evidence update failed")
    } finally {
      setPendingControlId(null)
    }
  }

  async function uploadArtifacts(item: PublicControlEvidenceItem, formData: FormData) {
    if (!item.evidenceId) return
    setPendingControlId(item.controlId)
    setError(null)
    try {
      const files = formData.getAll("files").filter((value): value is File => value instanceof File)
      const existingBytes = item.artifacts.reduce(
        (total, artifact) => total + artifact.byteLength,
        0
      )
      const selectedBytes = files.reduce((total, file) => total + file.size, 0)
      if (
        files.length === 0 ||
        files.length + item.artifacts.length > 5 ||
        existingBytes + selectedBytes > 20 * 1024 * 1024
      ) {
        throw new Error("Upload up to five allowed files totaling at most 20 MiB")
      }

      let nextItem = item
      for (const file of files) {
        nextItem = await readItem(
          await fetch(
            `/api/ai-assurance/evidence/${encodeURIComponent(item.evidenceId)}/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,
            {
              method: "POST",
              headers: {
                "content-type": file.type,
                "x-lyrashield-artifact-filename": encodeURIComponent(file.name),
              },
              body: file,
              signal: AbortSignal.timeout(30_000),
            }
          )
        )
      }
      replaceItem(nextItem)
    } catch (cause) {
      setError(
        cause instanceof DOMException && cause.name === "TimeoutError"
          ? "The artifact upload timed out"
          : cause instanceof Error
            ? cause.message
            : "The artifact upload failed"
      )
    } finally {
      setPendingControlId(null)
    }
  }

  async function review(item: PublicControlEvidenceItem, status: "ACCEPTED" | "REJECTED") {
    if (!item.evidenceId || !item.versionId) return
    setPendingControlId(item.controlId)
    setError(null)
    try {
      replaceItem(
        await apiPost<PublicControlEvidenceItem>(
          `/api/ai-assurance/evidence/${encodeURIComponent(item.evidenceId)}/review`,
          { workspaceId, versionId: item.versionId, status }
        )
      )
      setEditingControlId(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The evidence review failed")
    } finally {
      setPendingControlId(null)
    }
  }

  async function markNotApplicable(item: PublicControlEvidenceItem, formData: FormData) {
    if (!targetId) return
    setPendingControlId(item.controlId)
    setError(null)
    try {
      const reason = String(formData.get("notApplicableReason") ?? "").trim()
      replaceItem(
        await apiPost<PublicControlEvidenceItem>("/api/ai-assurance/evidence/not-applicable", {
          workspaceId,
          targetId,
          controlId: item.controlId,
          reason,
        })
      )
      setEditingControlId(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The evidence update failed")
    } finally {
      setPendingControlId(null)
    }
  }

  if (!targetId) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground">No targets available in this workspace.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <label className="grid gap-2">
          <span className="text-sm font-medium">Target</span>
          <select
            className="h-11 rounded-md border bg-background px-3 text-sm"
            value={targetId}
            onChange={(e) => {
              const id = e.target.value
              if (id) router.push(`/dashboard/ai-assurance?targetId=${id}`)
            }}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <Link
          href={`/dashboard/findings?tab=reports&targetId=${encodeURIComponent(targetId)}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          aria-label="Generate an assurance report"
        >
          <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
          Generate report
        </Link>
      </div>

      {/* At-a-glance completion sequence: profile → threat model → control
          evidence. Customer-declared, never a certification claim. */}
      <Card className="p-4">
        <ol className="grid gap-3 sm:grid-cols-3" aria-label="Evidence Vault progress">
          <li className="flex items-center gap-2.5">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                initialProfile ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
              }`}
              aria-hidden="true"
            >
              {initialProfile ? "✓" : "1"}
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">AI system profile</span>
              <span className="text-muted-foreground block text-xs">
                {initialProfile ? "Submitted" : "Not submitted"}
              </span>
            </span>
          </li>
          <li className="flex items-center gap-2.5">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                initialThreatModel ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
              }`}
              aria-hidden="true"
            >
              {initialThreatModel ? "✓" : "2"}
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">Threat model</span>
              <span className="text-muted-foreground block text-xs">
                {initialThreatModel ? "Submitted" : "Not submitted"}
              </span>
            </span>
          </li>
          <li className="flex items-center gap-2.5">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                acceptedCount + submittedCount > 0
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}
              aria-hidden="true"
            >
              3
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">Control evidence</span>
              <span className="text-muted-foreground block text-xs">
                {acceptedCount} accepted · {submittedCount} submitted · {requiredCount} required
              </span>
            </span>
          </li>
        </ol>
      </Card>

      <AssuranceInventory
        workspaceId={workspaceId}
        targetId={targetId}
        canManage={canManage}
        initialProfile={initialProfile}
        initialThreatModel={initialThreatModel}
      />

      <ul className="grid gap-4" role="list" aria-label="AI assurance control evidence">
        {items.map((item) => {
          const badge = STATE_BADGE[item.state] ?? {
            label: "Required",
            className: "bg-muted text-muted-foreground",
          }
          return (
            <li key={item.controlId}>
              <Card>
                <CardHeader className="pb-0">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <CardTitle as="h2" className="text-base">
                      {item.controlTitle}
                    </CardTitle>
                    <Badge className={badge.className}>{badge.label}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-3">
                  {item.attestation ? (
                    <p className="text-sm text-muted-foreground">{item.attestation}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No attestation submitted.</p>
                  )}

                  {item.artifacts.length > 0 && (
                    <ul className="space-y-1" aria-label="Artifacts for this control">
                      {item.artifacts.map((artifact) => (
                        <li
                          key={artifact.id}
                          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                        >
                          <span className="truncate">{artifact.filename}</span>
                          <span className="text-muted-foreground">{artifact.byteLength} bytes</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {item.versionId && (
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Version {item.version}</span>
                      {item.expiresAt && (
                        <span>Expires {new Date(item.expiresAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  )}

                  {(canManage || (canReview && item.state === "EVIDENCE_SUBMITTED")) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => {
                        setError(null)
                        setEditingControlId((current) =>
                          current === item.controlId ? null : item.controlId
                        )
                      }}
                      aria-expanded={editingControlId === item.controlId}
                      aria-controls={`evidence-actions-${item.controlId}`}
                      aria-label={`Manage evidence for ${item.controlTitle}`}
                    >
                      {editingControlId === item.controlId ? "Close" : "Manage"}
                    </Button>
                  )}

                  {editingControlId === item.controlId && (
                    <div
                      id={`evidence-actions-${item.controlId}`}
                      className="space-y-4 border-t pt-4"
                    >
                      {error && (
                        <p className="text-sm text-destructive" role="alert">
                          {error}
                        </p>
                      )}

                      {canManage && (
                        <form
                          className="grid gap-3"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void saveAttestation(item, new FormData(event.currentTarget))
                          }}
                        >
                          <label className="grid gap-2 text-sm font-medium">
                            Attestation
                            <textarea
                              name="attestation"
                              required
                              maxLength={5000}
                              defaultValue={item.attestation ?? ""}
                              className="min-h-28 rounded-md border bg-background px-3 py-2 font-normal"
                            />
                          </label>
                          <label className="grid gap-2 text-sm font-medium sm:max-w-xs">
                            Expiry date (optional)
                            <input
                              name="expiresAt"
                              type="date"
                              defaultValue={item.expiresAt?.slice(0, 10) ?? ""}
                              className="h-11 rounded-md border bg-background px-3 font-normal"
                            />
                          </label>
                          <Button
                            type="submit"
                            size="sm"
                            disabled={pendingControlId === item.controlId}
                          >
                            {item.evidenceId ? "Submit revision" : "Submit evidence"}
                          </Button>
                        </form>
                      )}

                      {canManage && item.evidenceId && (
                        <form
                          className="grid gap-3 border-t pt-4"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void uploadArtifacts(item, new FormData(event.currentTarget))
                          }}
                        >
                          <label className="grid gap-2 text-sm font-medium">
                            Evidence files
                            <input
                              name="files"
                              type="file"
                              multiple
                              required
                              accept="application/pdf,image/png,image/jpeg,text/plain"
                              className="text-sm font-normal"
                            />
                          </label>
                          <p className="text-xs text-muted-foreground">
                            PDF, PNG, JPEG, or text; up to 5 files and 20 MiB total.
                          </p>
                          <Button
                            type="submit"
                            variant="outline"
                            size="sm"
                            disabled={pendingControlId === item.controlId}
                          >
                            Upload files
                          </Button>
                        </form>
                      )}

                      {canManage && (
                        <form
                          className="grid gap-3 border-t pt-4"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void markNotApplicable(item, new FormData(event.currentTarget))
                          }}
                        >
                          <label className="grid gap-2 text-sm font-medium">
                            Why is this control not applicable?
                            <textarea
                              name="notApplicableReason"
                              required
                              maxLength={5000}
                              defaultValue={
                                item.state === "NOT_APPLICABLE" ? (item.attestation ?? "") : ""
                              }
                              className="min-h-24 rounded-md border bg-background px-3 py-2 font-normal"
                            />
                          </label>
                          <p className="text-xs text-muted-foreground">
                            This creates a new immutable evidence version and requires a reason.
                          </p>
                          <Button
                            type="submit"
                            variant="outline"
                            size="sm"
                            disabled={pendingControlId === item.controlId}
                          >
                            Mark not applicable
                          </Button>
                        </form>
                      )}

                      {canReview && item.state === "EVIDENCE_SUBMITTED" && (
                        <div className="flex flex-wrap gap-2 border-t pt-4">
                          <Button
                            type="button"
                            size="sm"
                            disabled={pendingControlId === item.controlId}
                            onClick={() => void review(item, "ACCEPTED")}
                          >
                            Accept version {item.version}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={pendingControlId === item.controlId}
                            onClick={() => void review(item, "REJECTED")}
                          >
                            Reject version {item.version}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
