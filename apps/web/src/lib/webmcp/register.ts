/// <reference types="webmcp-types" />

import { z } from "zod"
import {
  WEBMCP_BUDGETS,
  boundOutputValue,
  buildObjectSchema,
  enforceToolDescription,
  enforceToolName,
  enforceToolTitle,
  wrapToolCancellation,
  wrapToolError,
  wrapToolOutput,
  type WebMcpJsonSchemaProperty,
} from "./output"
import {
  createWebMcpReceiptStore,
  redactToolInputs,
  type WebMcpActivityReceipt,
  type WebMcpClassification,
  type WebMcpDataClass,
  type WebMcpReceiptStore,
} from "./receipts"

const activeToolRegistrations = new Map<string, AbortController>()

export interface WebMcpInputSchema {
  properties: Record<string, WebMcpJsonSchemaProperty>
  required?: string[]
}

export interface WebMcpToolDefinition<TInput extends Record<string, unknown>> {
  name: string
  title: string
  description: string
  inputSchema: WebMcpInputSchema
  annotations?: WebMCP.ToolAnnotations
  handler: (input: TInput, options: { signal: AbortSignal }) => Promise<unknown>
}

export interface WebMcpToolOptions<
  TInput extends Record<string, unknown>,
> extends WebMcpToolDefinition<TInput> {
  receiptStore: WebMcpReceiptStore
  classification: WebMcpClassification
  dataClass: WebMcpDataClass
  untrustedContent: boolean
  uiChanged: boolean
  humanConfirmationRequired: boolean
  /** Keys that must never be accepted from the agent (e.g. workspaceId). */
  forbiddenInputKeys?: string[]
  /** Extra keys to remove from receipt inputs for privacy. */
  sensitiveInputKeys?: string[]
}

/**
 * Register a page-scoped WebMCP tool with the browser's native `document.modelContext`.
 *
 * - Feature-detects `document.modelContext`.
 * - Enforces name, title, description, and parameter-description budgets.
 * - Rejects duplicate active names across the current tab.
 * - Creates an `AbortController` for registration lifetime and forwards
 *   cancellation into the handler's `AbortSignal`.
 * - Wraps every result, error, and cancellation in a bounded structured output.
 * - Emits a session receipt through the provided receipt store.
 */
export function registerWebMcpTool<TInput extends Record<string, unknown>>({
  name,
  title,
  description,
  inputSchema,
  annotations,
  handler,
  receiptStore,
  classification,
  dataClass,
  untrustedContent,
  uiChanged,
  humanConfirmationRequired,
  forbiddenInputKeys = [],
}: WebMcpToolOptions<TInput>): () => void {
  const boundedName = enforceToolName(name)
  const boundedTitle = enforceToolTitle(title)
  const boundedDescription = enforceToolDescription(description)

  const objectSchema = buildObjectSchema({
    description: boundedDescription,
    properties: inputSchema.properties,
    required: inputSchema.required,
  })

  if (activeToolRegistrations.has(boundedName)) {
    throw new Error(`WebMCP tool name already active: ${boundedName}`)
  }

  const registrationController = new AbortController()
  const toolAnnotations: WebMCP.ToolAnnotations = {
    readOnlyHint: classification === "read" || classification === "ui-only",
    untrustedContentHint: untrustedContent,
    ...annotations,
  }

  const tool: WebMCP.ModelContextTool = {
    name: boundedName,
    title: boundedTitle,
    description: boundedDescription,
    inputSchema: objectSchema,
    execute: async (inputObject, executeOptions) => {
      const rawInput = inputObject

      // Reject cross-workspace or cross-tenant input at the trust boundary.
      for (const key of forbiddenInputKeys) {
        if (
          rawInput !== null &&
          typeof rawInput === "object" &&
          !Array.isArray(rawInput) &&
          Object.prototype.hasOwnProperty.call(rawInput, key)
        ) {
          const rejected = receiptStore.add({
            toolName: boundedName,
            classification,
            status: "failed",
            dataClass,
            untrustedContent,
            uiChanged,
            durableMutation: false,
            humanConfirmationRequired,
            summary: `${boundedName} rejected forbidden input "${key}"`,
          })
          receiptStore.update(rejected.id, {
            endedAt: new Date().toISOString(),
          })
          return boundOutputValue(
            wrapToolError(`Input rejected: the parameter "${key}" is not allowed.`),
            WEBMCP_BUDGETS.output
          )
        }
      }

      let input: TInput
      try {
        input = validateToolInput(rawInput, objectSchema) as TInput
      } catch (error) {
        const rejected = receiptStore.add({
          toolName: boundedName,
          classification,
          status: "failed",
          dataClass,
          untrustedContent,
          uiChanged: false,
          durableMutation: false,
          humanConfirmationRequired,
          summary: `${boundedName} rejected invalid input`,
        })
        receiptStore.update(rejected.id, { endedAt: new Date().toISOString() })
        return boundOutputValue(
          wrapToolError(error instanceof Error ? error : "Invalid tool input"),
          WEBMCP_BUDGETS.output
        )
      }

      const executionController = new AbortController()

      const onExternalAbort = () => executionController.abort()
      if (executeOptions.signal) {
        if (executeOptions.signal.aborted) {
          executionController.abort()
        } else {
          executeOptions.signal.addEventListener("abort", onExternalAbort, { once: true })
        }
      }
      if (registrationController.signal.aborted) {
        executionController.abort()
      } else {
        registrationController.signal.addEventListener("abort", onExternalAbort, { once: true })
      }

      const receipt: WebMcpActivityReceipt = receiptStore.add({
        toolName: boundedName,
        classification,
        status: "running",
        dataClass,
        untrustedContent,
        uiChanged,
        durableMutation: false,
        humanConfirmationRequired,
        summary: `${boundedName} started`,
      })
      receiptStore.update(receipt.id, { summary: `${boundedName} started` })

      const cleanupAbortListeners = () => {
        executeOptions.signal?.removeEventListener("abort", onExternalAbort)
        registrationController.signal.removeEventListener("abort", onExternalAbort)
      }

      try {
        const result = await handler(input, { signal: executionController.signal })
        if (executionController.signal.aborted) {
          throw new DOMException("Tool execution was cancelled", "AbortError")
        }

        const output = wrapToolOutput(result, WEBMCP_BUDGETS.output)
        const summary = output.ok
          ? `${boundedName} completed`
          : `${boundedName} completed with an agent-visible issue`

        receiptStore.update(receipt.id, {
          status: "completed",
          endedAt: new Date().toISOString(),
          summary,
        })

        return boundOutputValue(output, WEBMCP_BUDGETS.output) as typeof output
      } catch (err) {
        if (
          executionController.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          receiptStore.update(receipt.id, {
            status: "cancelled",
            endedAt: new Date().toISOString(),
            summary: `${boundedName} cancelled`,
          })
          return boundOutputValue(wrapToolCancellation(), WEBMCP_BUDGETS.output)
        }

        const wrapped = wrapToolError(err instanceof Error ? err : "Tool execution failed")
        receiptStore.update(receipt.id, {
          status: "failed",
          endedAt: new Date().toISOString(),
          summary: `${boundedName} failed: ${wrapped.error ?? "unknown error"}`,
        })
        return boundOutputValue(wrapped, WEBMCP_BUDGETS.output)
      } finally {
        cleanupAbortListeners()
      }
    },
    annotations: toolAnnotations,
  }

  activeToolRegistrations.set(boundedName, registrationController)

  const discardFailedRegistration = () => {
    if (activeToolRegistrations.get(boundedName) === registrationController) {
      activeToolRegistrations.delete(boundedName)
      registrationController.abort()
    }
  }

  if (typeof document !== "undefined" && document.modelContext) {
    try {
      const registration = document.modelContext.registerTool(tool, {
        signal: registrationController.signal,
      })
      void Promise.resolve(registration).catch(discardFailedRegistration)
    } catch {
      discardFailedRegistration()
    }
  }

  return function cleanup() {
    if (activeToolRegistrations.get(boundedName) === registrationController) {
      activeToolRegistrations.delete(boundedName)
    }
    if (!registrationController.signal.aborted) {
      registrationController.abort()
    }
  }
}

function validateToolInput(
  input: unknown,
  schema: ReturnType<typeof buildObjectSchema>
): Record<string, unknown> {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, property] of Object.entries(schema.properties)) {
    const propertySchema = buildZodProperty(property)
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional()
  }
  return z.strictObject(shape).parse(input)
}

function buildZodProperty(property: WebMcpJsonSchemaProperty): z.ZodType {
  let schema: z.ZodType
  switch (property.type) {
    case "string":
      schema = z.string().max(WEBMCP_BUDGETS.output)
      break
    case "boolean":
      schema = z.boolean()
      break
    case "number":
      schema = z.number().finite()
      break
    case "array":
      schema = z.array(property.items ? buildZodProperty(property.items) : z.unknown())
      break
    case "object": {
      const required = new Set(property.required ?? [])
      const shape: Record<string, z.ZodType> = {}
      for (const [key, child] of Object.entries(property.properties ?? {})) {
        const childSchema = buildZodProperty(child)
        shape[key] = required.has(key) ? childSchema : childSchema.optional()
      }
      schema = z.strictObject(shape)
      break
    }
    default:
      schema = z.never()
  }

  return property.enum
    ? schema.refine((value) => property.enum?.includes(value), "Invalid enum value")
    : schema
}

// Convenience re-exports so the dashboard imports a single webmcp entry point.
export { createWebMcpReceiptStore, redactToolInputs }
export type { WebMcpActivityReceipt, WebMcpReceiptStore }
