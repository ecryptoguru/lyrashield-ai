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

export function remapSoftDeleteOperation(model: string | undefined, operation: string): string {
  if (!model || !SOFT_DELETE_MODELS.has(model)) return operation
  if (operation === "delete") return "update"
  if (operation === "deleteMany") return "updateMany"
  return operation
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

        const isSoftDelete =
          (operation === "delete" || operation === "deleteMany") &&
          model &&
          SOFT_DELETE_MODELS.has(model)
        const effectiveOperation = remapSoftDeleteOperation(model, operation)
        const finalArgs = isSoftDelete
          ? {
              ...guardedArgs,
              data: { deletedAt: new Date() },
            }
          : guardedArgs

        const callDelegate = async (
          delegateOwner: unknown,
          delegateOperation: string,
          delegateArgs: typeof finalArgs
        ) => {
          if (!model) throw new Error("Cannot dispatch a Prisma model operation without a model")
          const delegateName = model[0]!.toLowerCase() + model.slice(1)
          const delegate = (
            delegateOwner as Record<
              string,
              Record<string, (queryArgs: typeof finalArgs) => Promise<unknown>>
            >
          )[delegateName]
          const operationHandler = delegate?.[delegateOperation]
          if (!operationHandler) {
            throw new Error(`Unsupported scoped Prisma operation: ${model}.${delegateOperation}`)
          }
          return operationHandler.call(delegate, delegateArgs)
        }

        // Prisma's `query` continuation is fixed to the original operation.
        // Dispatch soft deletes through update/updateMany explicitly so the
        // rewritten deletedAt payload can never become a physical delete.
        if (isSoftDelete) {
          if (workspaceId && WORKSPACE_SCOPED_MODELS.has(model)) {
            return client.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
              return runWithDatabaseRLSContext(workspaceId, () =>
                callDelegate(tx, effectiveOperation, finalArgs)
              )
            })
          }
          return callDelegate(client, effectiveOperation, finalArgs)
        }

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
          return runWithDatabaseRLSContext(workspaceId, () =>
            callDelegate(tx, effectiveOperation, finalArgs)
          )
        })
      },
    },
  })
)
