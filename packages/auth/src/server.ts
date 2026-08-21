export { auth } from "./auth"
export type { Auth, Session, User } from "./auth"

export {
  getSession,
  requireAuth,
  getWorkspaceMembership,
  requireWorkspaceAccess,
  requirePermission,
  isPlatformOperator,
  requirePlatformOperator,
} from "./session"
export type { AuthSession, WorkspaceContext, ApiKeyAuthContext } from "./session"
export type { OAuthAuthContext } from "./session"
export { verifyOAuthBearer } from "./oauth"
export {
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_SCOPE_READ,
  OAUTH_SCOPE_WRITE,
  OAUTH_WORKSPACE_CLAIM,
} from "./auth"
