import { redirect } from "next/navigation"

/**
 * Compatibility route. Evidence now lives under the Issues → Evidence tab at
 * /dashboard/findings?tab=evidence. This permanent redirect preserves all
 * existing bookmarks and internal links.
 */
export default function EvidencePage() {
  permanentRedirect("/dashboard/findings?tab=evidence")
}
