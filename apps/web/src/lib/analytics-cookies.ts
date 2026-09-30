export const OPTIONAL_TRACKING_COOKIES = [
  "lyrashield-acq",
  "ls_ref",
  "ls_ref_source",
  "ls_scorecard_visitor",
] as const

export function clearOptionalTrackingCookies(
  response: Response,
  request: Pick<Request, "url">
): void {
  const url = new URL(request.url)
  const secure = url.protocol === "https:"
  const sharedDomainHosts = new Set([
    "lyrashieldai.com",
    "www.lyrashieldai.com",
    "app.lyrashieldai.com",
  ])
  const domains = [
    "",
    ...(sharedDomainHosts.has(url.hostname.toLowerCase()) ? ["; Domain=.lyrashieldai.com"] : []),
  ]
  const headers = response.headers
  for (const name of OPTIONAL_TRACKING_COOKIES) {
    for (const domain of domains) {
      headers.append(
        "Set-Cookie",
        `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${domain}${secure ? "; Secure" : ""}`
      )
    }
  }
}
