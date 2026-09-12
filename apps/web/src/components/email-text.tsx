/**
 * Cloudflare Email Address Obfuscation rewrites literal `user@host` text in the
 * SSR response into `__cf_email__` placeholder anchors. That post-flight DOM
 * rewrite mismatches React hydration (error #418), and the resulting fallback
 * re-render strips the `dark` class the theme boot script applied. Splitting
 * the address at the `@` across a `<wbr/>` keeps the wire HTML from matching
 * the obfuscator's pattern while rendering and copying identically in the DOM.
 */
export function EmailText({
  value,
  ...props
}: { value: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const at = value.indexOf("@")
  if (at < 0) return <span {...props}>{value}</span>
  return (
    <span {...props}>
      {value.slice(0, at)}
      <wbr />@{value.slice(at + 1)}
    </span>
  )
}
