import { describe, expect, it } from "vitest"

import { privacyBoundedPostHogEvent } from "./posthog-provider"

describe("privacyBoundedPostHogEvent", () => {
  it("keeps origins but removes private paths, query strings, and fragments", () => {
    const event = privacyBoundedPostHogEvent({
      properties: {
        $current_url: "https://app.lyrashieldai.com/dashboard/scans/private-id?token=x#finding",
        $referrer: "https://example.com/private/project?key=x",
        $pathname: "/dashboard/scans/private-id",
        $prev_pageview_url: "https://app.lyrashieldai.com/dashboard/targets/private-id",
        preset: "standard",
      },
    })

    expect(event.properties).toEqual({
      $current_url: "https://app.lyrashieldai.com",
      $referrer: "https://example.com",
      preset: "standard",
    })
  })
})
