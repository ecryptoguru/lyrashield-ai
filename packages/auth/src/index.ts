// Client-safe exports only — no server-only deps (next/headers, prisma, etc.)
export { authClient, signIn, signOut, signUp, useSession, getClientSession } from "./client"
export type { AuthClient } from "./client"

export {
  PERMISSIONS,
  hasPermission,
  hasMinimumRole,
  canGrantRole,
  getRolePermissions,
  isWorkspaceAdmin,
  isWorkspaceOwner,
} from "./permissions"
export type { Permission } from "./permissions"

// Server-only exports — import from "@lyrashield/auth/server" in server components
// export { auth } from "./auth"
// export type { Auth, Session, User } from "./auth"
// export { getSession, requireAuth, getWorkspaceMembership, requireWorkspaceAccess, requirePermission } from "./session"
// export type { AuthSession, WorkspaceContext } from "./session"
