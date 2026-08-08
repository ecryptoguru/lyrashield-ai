import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import {
  auth,
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_SCOPE_READ,
  OAUTH_SCOPE_WRITE,
} from "@lyrashield/auth/server"

const resourceClient = oauthProviderResourceClient(auth)

export async function protectedResourceMetadata(): Promise<Record<string, unknown>> {
  const metadata = await resourceClient.getActions().getProtectedResourceMetadata({
    resource: OAUTH_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE],
    bearer_methods_supported: ["header"],
  })
  return { ...metadata }
}
