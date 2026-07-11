import type { Instrumentation } from "next"
import { logger } from "@lyrashield/logger"

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  logger.error("Unhandled web request error", {
    path: request.path,
    method: request.method,
    route: context.routePath,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
}
