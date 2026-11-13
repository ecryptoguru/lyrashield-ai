"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { apiGet, apiPost, apiPut } from "@/lib/api-client"
import { formatDateTimeUtc } from "@/lib/date-format"
import { formatTargetDomainStatus } from "@/lib/target-domain-status-format"

const proofSchema = z.object({
  id: z.string(),
  domain: z.string(),
  status: z.string(),
  expiresAt: z.iso.datetime(),
  method: z.string().optional(),
})
const issueSchema = z.object({
  verification: proofSchema,
  dns: z.object({ host: z.string(), value: z.string() }),
})
export type DomainProof = z.infer<typeof proofSchema>

/**
 * The state machine of the domain-verification card: the stored proof, the
 * issued TXT record, the busy/error/message triple, the derived status line,
 * and the issue/verify/copy actions. It was the top half of
 * DomainVerificationContent and moved here unchanged so that component stays
 * inside the size ratchet. Same reads, same writes, same order of effects.
 */
export function useDomainVerificationState({
  workspaceId,
  domain,
  canValidate,
  initialStatus,
}: {
  workspaceId: string
  domain: string | null
  canValidate: boolean
  initialStatus: string
}) {
  const router = useRouter()
  const [proof, setProof] = useState<DomainProof | null>(null)
  const [dns, setDns] = useState<{ host: string; value: string } | null>(null)
  const [busy, setBusy] = useState(canValidate && !!domain)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!canValidate || !domain) return
    const controller = new AbortController()
    void apiGet(`/api/target-domain-verifications?${new URLSearchParams({ workspaceId })}`, {
      schema: z.array(proofSchema),
      signal: controller.signal,
      cache: "no-store",
    })
      .then((rows) => {
        if (!controller.signal.aborted) setProof(rows.find((row) => row.domain === domain) ?? null)
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load domain verification.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [workspaceId, domain, canValidate, attempt])

  const expired = !!proof && new Date(proof.expiresAt).getTime() <= now
  const initialExpiry = initialStatus.startsWith("Verified until ")
    ? Date.parse(initialStatus.slice(15))
    : null
  const status = proof
    ? expired
      ? "Not verified (expired)"
      : proof.status === "VERIFIED"
        ? `Verified until ${formatDateTimeUtc(proof.expiresAt)}`
        : initialStatus === "Self-attested"
          ? initialStatus
          : "Not verified"
    : initialExpiry !== null && initialExpiry <= now
      ? "Not verified (expired)"
      : canValidate && initialExpiry !== null
        ? "Not verified"
        : formatTargetDomainStatus(initialStatus)

  async function mutate(issue: boolean) {
    setBusy(true)
    setError(null)
    setMessage("")
    try {
      if (issue) {
        // A response can be lost after issuance invalidates the old proof.
        setProof(null)
        setDns(null)
        const result = await apiPost(
          "/api/target-domain-verifications",
          { workspaceId, domain },
          { schema: issueSchema }
        )
        setProof(result.verification)
        setDns(result.dns)
        setMessage(
          "New TXT record issued. Replace any previous record with these values; the previous proof is invalid."
        )
      } else if (proof) {
        const result = await apiPut(
          "/api/target-domain-verifications",
          { workspaceId, verificationId: proof.id },
          { schema: proofSchema }
        )
        if (
          result.domain !== domain ||
          result.status !== "VERIFIED" ||
          Date.parse(result.expiresAt) <= Date.now()
        )
          throw new Error("Domain verification did not succeed.")
        setProof(result)
        setMessage("Domain verified successfully.")
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify domain.")
    } finally {
      setBusy(false)
    }
  }

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(`${label} copied.`)
    } catch {
      setError("Clipboard unavailable. Select and copy the displayed value manually.")
    }
  }

  const retryStatus = () => {
    setError(null)
    setBusy(true)
    setAttempt((value) => value + 1)
  }

  return {
    proof,
    dns,
    busy,
    error,
    message,
    expired,
    status,
    issueRecord: () => void mutate(true),
    verifyRecord: () => void mutate(false),
    retryStatus,
    copy,
  }
}
