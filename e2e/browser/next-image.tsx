import type { ImgHTMLAttributes } from "react"

export default function Image(props: ImgHTMLAttributes<HTMLImageElement>) {
  // Test adapter preserves alt text and dimensions; image optimization is outside this harness.
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={props.alt ?? ""} />
}
