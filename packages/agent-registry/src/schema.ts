import { z } from "zod"

const configFormatSchema = z.enum(["json", "jsonc", "toml", "yaml"])
const installStrategySchema = z.enum(["config-file", "vendor-cli", "guided-manual"])
const transportSchema = z.enum(["stdio", "remote-http"])

const credentialStyleSchema = z.union([
  z.object({ kind: z.literal("inline-env") }),
  z.object({ kind: z.literal("interpolated-env"), syntax: z.string().min(1) }),
  z.object({ kind: z.literal("env-names"), field: z.string().min(1) }),
  z.object({ kind: z.literal("shell-env") }),
  z.object({ kind: z.literal("http-header"), header: z.string().min(1) }),
  z.object({ kind: z.literal("ui-fields") }),
])

const configLocationSchema = z.object({
  scope: z.enum(["project", "global"]),
  path: z.string().min(1),
  platform: z.partialRecord(z.enum(["darwin", "linux", "win32"]), z.string().min(1)).optional(),
  sharedByConvention: z.boolean(),
})

export const agentEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    displayName: z.string().min(1),
    docsSlug: z.string().regex(/^[a-z0-9-]+$/),
    installStrategy: installStrategySchema,
    format: configFormatSchema.nullable(),
    rootKey: z.string().nullable(),
    locations: z.array(configLocationSchema),
    transports: z.array(transportSchema).min(1),
    credential: credentialStyleSchema,
    requiredEntryFields: z.record(z.string(), z.string()).optional(),
    transportFields: z.partialRecord(transportSchema, z.record(z.string(), z.string())).optional(),
    commandWrapperKey: z.string().nullable().optional(),
    vendorCli: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
      })
      .optional(),
    rulesFiles: z.array(z.string().min(1)),
    serverNameConstraint: z.string().optional(),
    gotchas: z.array(z.string().min(1)),
  })
  .superRefine((entry, ctx) => {
    if (entry.installStrategy === "config-file") {
      if (entry.format === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "format is required when installStrategy is config-file",
          path: ["format"],
        })
      }
      if (entry.rootKey === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rootKey is required when installStrategy is config-file",
          path: ["rootKey"],
        })
      }
      if (entry.locations.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "at least one location is required when installStrategy is config-file",
          path: ["locations"],
        })
      }
    } else {
      if (entry.format !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `format must be null when installStrategy is ${entry.installStrategy}`,
          path: ["format"],
        })
      }
      if (entry.rootKey !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rootKey must be null when installStrategy is ${entry.installStrategy}`,
          path: ["rootKey"],
        })
      }
      if (entry.locations.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `locations must be empty when installStrategy is ${entry.installStrategy}`,
          path: ["locations"],
        })
      }
    }
  })

export type ValidatedAgentEntry = z.infer<typeof agentEntrySchema>
