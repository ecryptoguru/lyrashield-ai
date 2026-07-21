import { Prisma } from "./generated/prisma"
import {
  SOFT_DELETE_MODELS,
  WORKSPACE_SCOPED_MODELS,
  applyQueryGuards,
  getExplicitWorkspaceId,
  getWorkspaceContext,
  isDatabaseRLSContextBound,
  runWithDatabaseRLSContext,
  setWorkspaceContext,
  runWithWorkspaceContext,
} from "./scoping"

// Re-export the request-context helpers + policy sets so existing import sites
// (`@lyrashield/db`) keep working.
export {
  SOFT_DELETE_MODELS,
  WORKSPACE_SCOPED_MODELS,
  getExplicitWorkspaceId,
  getWorkspaceContext,
  isDatabaseRLSContextBound,
  runWithDatabaseRLSContext,
  setWorkspaceContext,
  runWithWorkspaceContext,
}

export const workspaceExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "workspace-rls",
    query: {
      async $allOperations({ model, operation, args, query }) {
        const activeWorkspaceId = getWorkspaceContext()
        const workspaceId =
          activeWorkspaceId ?? getExplicitWorkspaceId(args as Record<string, unknown>)
        const guardedArgs = applyQueryGuards(
          model,
          operation,
          args as Record<string, unknown>,
          activeWorkspaceId
        )

        const finalArgs =
          (operation === "delete" || operation === "deleteMany") &&
          model &&
          SOFT_DELETE_MODELS.has(model)
            ? {
                ...guardedArgs,
                data: { deletedAt: new Date() },
              }
            : guardedArgs

        if (!model || !workspaceId || !WORKSPACE_SCOPED_MODELS.has(model)) {
          return query(finalArgs)
        }

        // AuditLog.create has a dedicated extension that owns advisory locking,
        // transaction-local RLS context, and hash-chain fields. Let it execute
        // instead of bypassing it through the generic transaction delegate.
        if (model === "AuditLog" && operation === "create") {
          return query(finalArgs)
        }

        if (isDatabaseRLSContextBound()) {
          return query(finalArgs)
        }

        // SET LOCAL and the protected query must share one connection. Keep the
        // interactive transaction to these two database operations only. Calling
        // the transaction delegate directly also prevents this extension from
        // recursively wrapping its own query.
        return client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
          const delegateName = model[0]!.toLowerCase() + model.slice(1)
          const delegate = (
            tx as unknown as Record<
              string,
              Record<string, (queryArgs: typeof finalArgs) => Promise<unknown>>
            >
          )[delegateName]
          const operationHandler = delegate?.[operation]
          if (!operationHandler) {
            throw new Error(`Unsupported scoped Prisma operation: ${model}.${operation}`)
          }
          return operationHandler.call(delegate, finalArgs)
        })
      },
    },
  })
)
