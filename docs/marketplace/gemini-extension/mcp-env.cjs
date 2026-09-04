// Preserve an explicit API URL override with stored OAuth. Only an explicit
// extension credential may override it; empty settings must remain absent.
const apiKey = process.env.LYRASHIELD_EXTENSION_CRED?.trim()
delete process.env.LYRASHIELD_API_KEY
delete process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN
delete process.env.LYRASHIELD_EXTENSION_CRED
if (apiKey) {
  process.env.LYRASHIELD_API_KEY = apiKey
  process.env.LYRASHIELD_API_URL = "https://app.lyrashieldai.com"
}
