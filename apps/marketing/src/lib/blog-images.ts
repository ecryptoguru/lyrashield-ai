/** URLs produced by the build's responsive image step from the approved catalog. */
export function blogImageSrcset(source: string): string {
  const base = source.replace("/library/", "/responsive/")
  const small = base.replace("/hero.", "/hero-480.")
  const medium = base.replace("/hero.", "/hero-960.")
  return `${small} 480w, ${medium} 960w, ${source} 1600w`
}
