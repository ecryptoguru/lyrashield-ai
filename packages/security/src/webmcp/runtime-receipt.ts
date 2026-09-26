import { z } from "zod"

const checkIds = [
  "NATIVE_API",
  "DISCOVERY",
  "SCHEMA_REJECTION",
  "OUTPUT_BOUND",
  "CANCELLATION",
  "CLEANUP",
  "CROSS_ORIGIN",
  "CONFIRMATION",
] as const

export const webMcpRuntimeReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("lyrashield-webmcp-runtime/1"),
    runId: z.uuid(),
    checkedAt: z.iso.datetime(),
    browser: z.strictObject({
      name: z.string().min(1).max(40),
      version: z.string().min(1).max(40),
      nativeApiAvailable: z.boolean(),
    }),
    target: z.strictObject({
      origin: z.url().refine((value) => {
        const url = new URL(value)
        return url.origin === value && !url.username && !url.password
      }, "Expected an exact origin without credentials, path, or query"),
      revision: z
        .string()
        .regex(/^[a-zA-Z0-9._-]{1,64}$/)
        .optional(),
      contentChecksum: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    checks: z
      .array(
        z.strictObject({
          id: z.enum(checkIds),
          state: z.enum(["PASS", "FAIL", "INCONCLUSIVE", "NOT_APPLICABLE"]),
          method: z.literal("native-browser"),
          summary: z.string().min(1).max(200),
        })
      )
      .min(1)
      .max(checkIds.length),
    limits: z.strictObject({
      timedOut: z.boolean(),
      skipped: z.array(z.string().min(1).max(80)).max(checkIds.length),
    }),
  })
  .superRefine((receipt, context) => {
    const ids = receipt.checks.map((check) => check.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Duplicate runtime check ID", path: ["checks"] })
    }
    if (
      !receipt.browser.nativeApiAvailable &&
      receipt.checks.some((check) => check.state === "PASS")
    ) {
      context.addIssue({
        code: "custom",
        message: "Native PASS requires native API",
        path: ["checks"],
      })
    }
  })

export type WebMcpRuntimeReceipt = z.infer<typeof webMcpRuntimeReceiptSchema>

export function parseWebMcpRuntimeReceipt(value: unknown): WebMcpRuntimeReceipt {
  return webMcpRuntimeReceiptSchema.parse(value)
}
