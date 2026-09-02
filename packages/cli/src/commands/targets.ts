import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import { normalizeDomainForProof } from "@lyrashield/security"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid API response")
  return value as Record<string, unknown>
}

function parseProof(value: unknown) {
  const proof = record(value)
  if (
    typeof proof.id !== "string" ||
    typeof proof.domain !== "string" ||
    typeof proof.status !== "string" ||
    typeof proof.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(proof.expiresAt))
  )
    throw new Error("Invalid domain proof response")
  return {
    id: proof.id,
    domain: proof.domain,
    status: proof.status,
    expiresAt: proof.expiresAt,
    method: proof.method,
  }
}

export async function handleTargets(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["name", "type", "url", "repo"],
    boolean: ["issue", "check"],
  })
  if (parsed._[0] === "verify-domain") {
    if (parsed._.length !== 2 || typeof parsed._[1] !== "string" || !parsed._[1].trim())
      throw new Error("Usage: lyrashield targets verify-domain <targetId> [--issue|--check]")
    if (parsed.issue && parsed.check) throw new Error("Choose either --issue or --check, not both")
    if (parsed.name || parsed.type || parsed.url || parsed.repo)
      throw new Error("Target creation flags cannot be used with verify-domain")
    const targetId = parsed._[1]
    const workspaceId = requireWorkspace(await getEffectiveCredentials())
    const client = await createClient()
    // The existing target list API owns workspace access and pagination.
    let cursor: string | null = null
    const seen = new Set<string>()
    let target: Record<string, unknown> | undefined
    do {
      const query = new URLSearchParams({ workspaceId, ...(cursor ? { cursor } : {}) })
      const page = record(await client.request("GET", `/targets?${query}`))
      if (!Array.isArray(page.items)) throw new Error("Invalid target list response")
      target = page.items.map(record).find((item) => item.id === targetId)
      if (target) break
      if (page.nextCursor !== null && typeof page.nextCursor !== "string")
        throw new Error("Invalid pagination cursor")
      cursor = page.nextCursor as string | null
      if (cursor && seen.has(cursor)) throw new Error("Target pagination did not advance")
      if (cursor) seen.add(cursor)
    } while (cursor)
    if (!target) throw new Error("Target not found in the selected workspace")
    if (target.type !== "WEB_APP" && target.type !== "API")
      throw new Error("Domain verification applies only to WEB_APP and API targets")
    const domain = typeof target.url === "string" ? normalizeDomainForProof(target.url) : null
    if (!domain) throw new Error("Target has no valid public domain")
    if (parsed.issue) {
      const issued = record(
        await client.request("POST", "/target-domain-verifications", {
          body: { workspaceId, domain },
        })
      )
      const proof = parseProof(issued.verification)
      const dns = record(issued.dns)
      if (
        proof.domain !== domain ||
        dns.host !== `_lyrashield.${domain}` ||
        typeof dns.value !== "string"
      )
        throw new Error("Domain proof response does not match the target")
      output.result({
        targetId,
        workspaceId,
        domain,
        verification: proof,
        dns,
        instructions:
          "Publish the DNS TXT record, then run with --check. This replaces the previous token and verified status. Save the value now; it is only returned on issue.",
      })
      return 0
    }
    const rows = await client.request(
      "GET",
      `/target-domain-verifications?${new URLSearchParams({ workspaceId })}`
    )
    if (!Array.isArray(rows)) throw new Error("Invalid domain proof list")
    // API sorts newest first. Only this normalized domain in this workspace is relevant.
    const proof = rows.map(parseProof).find((row) => row.domain === domain)
    if (parsed.check) {
      if (!proof || proof.method !== "DNS_TXT" || Date.parse(proof.expiresAt) <= Date.now())
        throw new Error("No current DNS proof. Run with --issue first")
      const verified = parseProof(
        await client.request("PUT", "/target-domain-verifications", {
          body: { workspaceId, verificationId: proof.id },
        })
      )
      if (
        verified.domain !== domain ||
        verified.status !== "VERIFIED" ||
        Date.parse(verified.expiresAt) <= Date.now()
      )
        throw new Error("Domain verification did not succeed")
      output.result({ targetId, workspaceId, ...verified })
      return 0
    }
    const status =
      proof && Date.parse(proof.expiresAt) <= Date.now()
        ? "EXPIRED"
        : (proof?.status ?? "NOT_VERIFIED")
    output.result({
      targetId,
      workspaceId,
      domain,
      status,
      expiresAt: proof?.expiresAt ?? null,
      instructions:
        status === "VERIFIED"
          ? "Domain control is verified until the stated expiry."
          : "Run with --issue to obtain a DNS TXT value, then --check after publishing it. Saved tokens cannot be retrieved; reissuing invalidates the previous proof.",
    })
    return 0
  }
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (parsed.name) {
    const body: Record<string, unknown> = {
      workspaceId,
      name: parsed.name,
      type: parsed.type ?? "repo",
    }
    if (parsed.url) body.url = parsed.url
    if (parsed.repo) body.repository = parsed.repo
    const res = await client.request("POST", "/targets", { body })
    output.result(res)
  } else {
    const res = await client.request(
      "GET",
      `/targets?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
  }

  return 0
}
