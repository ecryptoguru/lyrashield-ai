// Client-safe exports only — no server-only deps (next/headers, prisma, etc.)
export {
  authClient,
  signIn,
  signOut,
  signUp,
  useSession,
  getClientSession,
  safeAuthCallbackPath,
} from "./client"
export type { AuthClient } from "./client"
export { getAuthErrorMessage, getAuthErrorCode, isEmailNotVerifiedError } from "./client"
export type { AuthClientError } from "./client"
export { isOAuthProviderConfigured } from "./oauth-providers"

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
