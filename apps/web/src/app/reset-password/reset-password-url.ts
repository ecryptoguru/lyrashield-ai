/** Remove only the one-time credential while keeping the rest of the link. */
export function cleanResetTokenFromUrl(currentHref: string): string {
  const url = new URL(currentHref)
  url.searchParams.delete("token")
  return `${url.pathname}${url.search}${url.hash}`
}
