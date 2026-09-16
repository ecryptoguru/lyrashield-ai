/**
 * Scoped support memory — authenticated accounts only, allowlisted keys,
 * never authority-bearing. Anonymous memory stays client-side.
 */
import { z } from "zod"
import { isAllowedMemoryWrite, MYRA_MEMORY_KEYS } from "../../memory-keys"
import { err } from "../errors"
import { withOwnerScope } from "../db"
import type { MyraToolContext, MyraToolResult } from "./types"

export const readMemoryInput = z.object({}).strict()
export const writeMemoryInput = z.object({
  key: z.string().max(60),
  value: z.unknown(),
})

const KEY_LABELS: Record<string, string> = {
  preferred_timezone: "Preferred timezone",
  preferred_locale: "Preferred locale",
  dismissed_flows: "Dismissed guides",
  preferred_depth: "Answer depth",
}

function requireUser(ctx: MyraToolContext): string {
  if (ctx.principal.kind !== "user") {
    throw err("UNAUTHORIZED", "Memory is available for signed-in accounts only.")
  }
  return ctx.principal.accountId
}

export async function runReadMemory(
  ctx: MyraToolContext,
  _input: unknown
): Promise<MyraToolResult> {
  const accountId = requireUser(ctx)
  const rows = await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.myraMemory.findMany({
        where: { accountId },
        select: { key: true, value: true, updatedAt: true },
        orderBy: { key: "asc" },
      }),
    ctx.db
  )
  return {
    data: {
      entries: rows.map((r) => ({ key: r.key, value: r.value })),
    },
    components: [
      {
        type: "memory_card",
        entries: rows.map((r) => ({
          key: r.key,
          label: KEY_LABELS[r.key] ?? r.key,
        })),
      },
    ],
  }
}

export async function runWriteMemory(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const accountId = requireUser(ctx)
  const { key, value } = writeMemoryInput.parse(input)
  if (!isAllowedMemoryWrite(key, value)) {
    throw err("VALIDATION_ERROR", "That memory key or value is not allowed.")
  }
  await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.myraMemory.upsert({
        where: { accountId_key: { accountId, key } },
        create: { accountId, key, value: value as object },
        update: { value: value as object },
      }),
    ctx.db
  )
  return { data: { written: key, allowed: MYRA_MEMORY_KEYS } }
}
