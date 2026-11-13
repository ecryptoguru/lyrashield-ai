import { z } from "zod"

const id = z.string().min(1).max(192)
const messageText = z.string().max(4 * 1024 * 1024)
const directCaller = z.object({ type: z.literal("direct") }).strict()
const content = z.union([
  messageText,
  z
    .array(
      z.union([
        z.object({ type: z.literal("input_text"), text: messageText }).strict(),
        z
          .object({
            type: z.literal("output_text"),
            text: messageText,
            annotations: z.array(z.never()).max(0).optional(),
          })
          .strict(),
      ])
    )
    .max(256),
])

const message = z
  .object({
    type: z.literal("message").optional(),
    id: id.optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    content,
  })
  .strict()
const functionCall = z
  .object({
    type: z.literal("function_call"),
    id: id.optional(),
    call_id: id,
    name: id,
    arguments: messageText,
    caller: directCaller.optional(),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .strict()
const functionOutput = z
  .object({
    type: z.literal("function_call_output"),
    call_id: id,
    output: messageText,
    id: id.optional(),
  })
  .strict()
const customCall = z
  .object({
    type: z.literal("custom_tool_call"),
    id: id.optional(),
    call_id: id,
    name: id,
    input: messageText,
    caller: directCaller.optional(),
  })
  .strict()
const customOutput = z
  .object({
    type: z.literal("custom_tool_call_output"),
    call_id: id,
    output: messageText,
    id: id.optional(),
  })
  .strict()
const shellCall = z
  .object({
    type: z.literal("shell_call"),
    id,
    call_id: id,
    status: z.enum(["in_progress", "completed", "incomplete"]),
    caller: directCaller.optional(),
    action: z
      .object({
        commands: z.array(messageText).min(1).max(64),
        timeout_ms: z.number().int().positive().max(2_700_000).optional(),
        max_output_length: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024)
          .optional(),
      })
      .strict(),
    environment: z
      .object({ type: z.literal("local") })
      .strict()
      .optional(),
  })
  .strict()
const shellOutput = z
  .object({
    type: z.literal("shell_call_output"),
    call_id: id,
    output: z
      .array(
        z
          .object({
            stdout: messageText,
            stderr: messageText,
            outcome: z.union([
              z.object({ type: z.literal("exit"), exit_code: z.number().int() }).strict(),
              z.object({ type: z.literal("timeout") }).strict(),
            ]),
          })
          .strict()
      )
      .max(64),
    max_output_length: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024)
      .optional(),
    id: id.optional(),
  })
  .strict()
const patchCall = z
  .object({
    type: z.literal("apply_patch_call"),
    id,
    call_id: id,
    status: z.enum(["in_progress", "completed"]),
    caller: directCaller.optional(),
    operation: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("create_file"),
          path: z.string().min(1).max(4096),
          diff: messageText,
        })
        .strict(),
      z
        .object({
          type: z.literal("update_file"),
          path: z.string().min(1).max(4096),
          diff: messageText,
        })
        .strict(),
      z.object({ type: z.literal("delete_file"), path: z.string().min(1).max(4096) }).strict(),
    ]),
  })
  .strict()
const patchOutput = z
  .object({
    type: z.literal("apply_patch_call_output"),
    call_id: id,
    status: z.enum(["completed", "failed"]),
    output: messageText.optional(),
    id: id.optional(),
  })
  .strict()
const reasoning = z
  .object({
    type: z.literal("reasoning"),
    id,
    summary: z
      .array(z.object({ type: z.literal("summary_text"), text: messageText }).strict())
      .max(64),
    encrypted_content: messageText.nullable().optional(),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .strict()

function localSchema(value: Record<string, unknown>): boolean {
  if (value.type !== "object") return false
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === "number" && !Number.isFinite(item)) return false
    if (!item || typeof item !== "object") continue
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child)
      continue
    }
    for (const [key, child] of Object.entries(item)) {
      if (["$id", "$dynamicRef", "$recursiveRef"].includes(key)) return false
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) return false
      pending.push(child)
    }
  }
  return true
}

const tool = z
  .object({
    type: z.literal("function"),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: messageText.optional(),
    parameters: z.record(z.string(), z.unknown()).refine(localSchema),
    strict: z.boolean(),
  })
  .strict()
const customTool = z
  .object({
    type: z.literal("custom"),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: messageText.optional(),
  })
  .strict()
const shellTool = z
  .object({
    type: z.literal("shell"),
    environment: z.object({ type: z.literal("local") }).strict(),
  })
  .strict()
const patchTool = z.object({ type: z.literal("apply_patch") }).strict()

export const agentRequestSchema = z
  .object({
    model: z.string().min(1).max(128),
    input: z.union([
      messageText,
      z
        .array(
          z.union([
            message,
            functionCall,
            functionOutput,
            customCall,
            customOutput,
            shellCall,
            shellOutput,
            patchCall,
            patchOutput,
            reasoning,
          ])
        )
        .min(1)
        .max(256),
    ]),
    instructions: messageText.optional(),
    max_output_tokens: z.number().int().positive(),
    stream: z.boolean().default(false),
    tools: z
      .array(z.union([tool, customTool, shellTool, patchTool]))
      .max(64)
      .optional(),
    tool_choice: z
      .union([
        z.enum(["none", "auto", "required"]),
        z.object({ type: z.literal("function"), name: id }).strict(),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
        summary: z.enum(["auto", "concise", "detailed"]).optional(),
      })
      .strict()
      .optional(),
    include: z.array(z.literal("reasoning.encrypted_content")).max(1).optional(),
    store: z.literal(false).optional(),
    text: z
      .object({
        format: z
          .object({
            type: z.literal("json_schema"),
            name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            schema: z.record(z.string(), z.unknown()).refine(localSchema),
            strict: z.literal(true),
            description: messageText.optional(),
          })
          .strict(),
        verbosity: z.enum(["low", "medium", "high"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
