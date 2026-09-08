export { auth } from "./auth"
export type { Auth, Session, User } from "./auth"

export {
  getSession,
  requireAuth,
  getWorkspaceMembership,
  requireWorkspaceAccess,
  requirePermission,
  assertOAuthDelegatedScope,
  getPlatformAdminNavigationState,
  isPlatformOperator,
  requirePlatformAdminCandidateIdentity,
  requirePlatformAdminIdentity,
  requirePlatformAdmin,
  requirePlatformOperator,
  MAX_PLATFORM_ADMIN_ELEVATION_AGE_MS,
  MAX_PLATFORM_ADMIN_READ_AGE_MS,
} from "./session"
export type {
  AuthSession,
  WorkspaceContext,
  ApiKeyAuthContext,
  PlatformAdminIdentity,
  PlatformAdminNavigationState,
} from "./session"
export type { OAuthAuthContext } from "./session"
export { verifyOAuthBearer } from "./oauth"
export {
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_SCOPE_READ,
  OAUTH_SCOPE_WRITE,
  OAUTH_WORKSPACE_CLAIM,
  OAUTH_CONNECTION_CLAIM,
  OAUTH_AUTH_VERSION_CLAIM,
} from "./auth"
