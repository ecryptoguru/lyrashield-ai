export { auth } from "./auth"
export type { Auth, Session, User } from "./auth"

export {
  getSession,
  requireAuth,
  getWorkspaceMembership,
  requireWorkspaceAccess,
  requirePermission,
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
} from "./session"
export type { OAuthAuthContext } from "./session"
export { verifyOAuthBearer } from "./oauth"
export {
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_SCOPE_READ,
  OAUTH_SCOPE_WRITE,
  OAUTH_WORKSPACE_CLAIM,
} from "./auth"
