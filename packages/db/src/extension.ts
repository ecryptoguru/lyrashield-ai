import { Prisma } from "./generated/prisma"
import {
  SOFT_DELETE_MODELS,
  WORKSPACE_SCOPED_MODELS,
  applyQueryGuards,
  getWorkspaceContext,
  setWorkspaceContext,
  runWithWorkspaceContext,
} from "./scoping"

// Re-export the request-context helpers + policy sets so existing import sites
// (`@lyrashield/db`) keep working.
export {
  SOFT_DELETE_MODELS,
  WORKSPACE_SCOPED_MODELS,
  getWorkspaceContext,
  setWorkspaceContext,
  runWithWorkspaceContext,
}

export const workspaceExtension = Prisma.defineExtension({
  query: {
    $allOperations({ model, operation, args, query }) {
      const guardedArgs = applyQueryGuards(
        model,
        operation,
        args as Record<string, unknown>,
        getWorkspaceContext()
      )

      if (
        (operation === "delete" || operation === "deleteMany") &&
        model &&
        SOFT_DELETE_MODELS.has(model)
      ) {
        return query({
          ...guardedArgs,
          data: { deletedAt: new Date() },
        })
      }

      return query(guardedArgs)
    },
  },
})
