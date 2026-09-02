// Keep stored OAuth credentials bound to their stored issuer. Only an explicit
// extension setting may override them; empty settings must remain absent.
const apiKey = process.env.LYRASHIELD_EXTENSION_CRED?.trim()
delete process.env.LYRASHIELD_API_KEY
delete process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN
delete process.env.LYRASHIELD_API_URL
delete process.env.LYRASHIELD_EXTENSION_CRED
if (apiKey) {
  process.env.LYRASHIELD_API_KEY = apiKey
  process.env.LYRASHIELD_API_URL = "https://app.lyrashieldai.com"
}
