/**
 * One publication predicate shared by every collection consumer.
 *
 * Before this, only `draft` gated publication. A future-dated post with
 * `draft: false` went live on the deploy that carried it: the listing, the
 * tag hubs, the sitemap, the RSS feed and llms.txt all included it, and
 * llms.txt even bumped its own "Last updated" date to the post's future
 * pubDate. Batch-11 (pubDates 2026-09-21 to 2026-09-25) all shipped at once.
 *
 * The rule is deliberately a build-time gate rather than a scheduled deploy:
 * there is no cron workflow. A future-dated post is simply held back and
 * appears on the first deploy on or after its pubDate, because at that build
 * the pubDate is no longer after the build date.
 *
 * `BUILD_DATE` is captured once when this module is first evaluated so every
 * consumer in one build agrees on the same cutoff.
 */
export const BUILD_DATE: Date = new Date()

export interface PublishableData {
  pubDate: Date
  draft?: boolean
}

export interface PublishableEntry {
  data: PublishableData
}

/** True when a post's pubDate is not after the build date. */
export function isNotAfterBuildDate(data: PublishableData, now: Date = BUILD_DATE): boolean {
  return data.pubDate.getTime() <= now.getTime()
}

/** True when the post's pubDate is still in the future relative to the build. */
export function isFutureDated(data: PublishableData, now: Date = BUILD_DATE): boolean {
  return !isNotAfterBuildDate(data, now)
}

/**
 * A post is live when it is not a draft AND its pubDate is not after the build
 * date. This is the single predicate every collection consumer filters with,
 * shaped for Astro's `getCollection("blog", predicate)` filter callback.
 */
export function isPublished(entry: PublishableEntry, now: Date = BUILD_DATE): boolean {
  return entry.data.draft !== true && isNotAfterBuildDate(entry.data, now)
}

/** Cap a derived content date so it never claims a date later than the build. */
export function clampToBuildDate(date: Date, now: Date = BUILD_DATE): Date {
  return date.getTime() > now.getTime() ? now : date
}
