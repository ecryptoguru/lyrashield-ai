import { getOperationStatus, type OperationStatus } from "@lyrashield/sdk"
import minimist from "minimist"
import { setTimeout as sleep } from "node:timers/promises"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import { followScan, parseWaitTimeout } from "../scan-follow.js"

export async function handleStatus(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { boolean: ["watch"], string: ["operation", "timeout"] })
  const [scanId] = parsed._
  if (parsed.operation && scanId) {
    output.error("Supply a scan ID or --operation, not both.")
    return 2
  }

  const timeoutMs = parseWaitTimeout(parsed.timeout)
  if (parsed.watch && timeoutMs === null) {
    output.error("--timeout must be an integer from 1 to 86400 seconds")
    return 2
  }
  if (parsed.watch && !parsed.operation && !scanId) {
    output.error("--watch requires a scan ID or --operation ID")
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (parsed.operation) {
    if (parsed.watch) {
      return followOperation(client, parsed.operation, workspaceId, timeoutMs!, output)
    }
    const res = await getOperationStatus(client, parsed.operation, workspaceId)
    output.result(res)
    return 0
  }
  if (scanId) {
    if (parsed.watch) return followScan(client, scanId, workspaceId, timeoutMs!, output)
    const res = await client.request(
      "GET",
      `/scans/${encodeURIComponent(scanId)}?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
    return 0
  }

  const res = await client.request("GET", `/scans?workspaceId=${encodeURIComponent(workspaceId)}`)
  output.result(res)
  return 0
}

async function followOperation(
  client: Awaited<ReturnType<typeof createClient>>,
  operationId: string,
  workspaceId: string,
  timeoutMs: number,
  output: Output
): Promise<number> {
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once("SIGINT", onInterrupt)
  const deadline = Date.now() + timeoutMs
  let lastStatus: OperationStatus["status"] | undefined
  try {
    while (Date.now() < deadline) {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ])
      const operation = await getOperationStatus(client, operationId, workspaceId, signal)
      if (operation.status !== lastStatus) {
        process.stderr.write(`Operation ${operationId}: ${operation.status}\n`)
        lastStatus = operation.status
      }
      if (["COMPLETED", "FAILED", "CONFLICT"].includes(operation.status)) {
        if (
          operation.status === "COMPLETED" &&
          operation.operationName === "scan.create" &&
          operation.resultLocation &&
          /^c[a-z0-9]{24,}$/.test(operation.resultLocation)
        ) {
          return followScan(
            client,
            operation.resultLocation,
            workspaceId,
            Math.max(1, deadline - Date.now()),
            output,
            operationId
          )
        }
        output.result(operation)
        return operation.status === "COMPLETED" ? 0 : 7
      }
      await sleep(Math.min(5_000, deadline - Date.now()), undefined, {
        signal: controller.signal,
      })
    }
    output.error(
      `Timed out waiting for operation ${operationId}; resume: lyrashield status --operation ${operationId} --watch`,
      8
    )
    return 8
  } catch (error) {
    if (controller.signal.aborted) {
      output.error(
        `Stopped waiting for operation ${operationId}; it may still be running; resume: lyrashield status --operation ${operationId} --watch`,
        130
      )
      return 130
    }
    if (
      Date.now() >= deadline &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "REQUEST_ABORTED"
    ) {
      output.error(
        `Timed out waiting for operation ${operationId}; resume: lyrashield status --operation ${operationId} --watch`,
        8
      )
      return 8
    }
    throw error
  } finally {
    process.removeListener("SIGINT", onInterrupt)
  }
}
