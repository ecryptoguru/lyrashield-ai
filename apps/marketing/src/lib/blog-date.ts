/** One editorial calendar across article bylines, cards and search. */
export function formatBlogDate(date: Date, month: "short" | "long" = "short"): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month,
    day: "numeric",
    timeZone: "Asia/Kolkata",
  })
}
