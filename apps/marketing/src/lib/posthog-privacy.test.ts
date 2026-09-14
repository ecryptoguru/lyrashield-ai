import { describe, expect, it } from "vitest"
import { privacyBoundedMarketingEvent } from "./posthog-privacy"

describe("privacyBoundedMarketingEvent", () => {
  it("removes session-entry query strings, fragments, and malformed URLs", () => {
    const event = privacyBoundedMarketingEvent({
      properties: {
        $current_url: "https://example.test/page?secret=1#fragment",
        $session_entry_url: "https://example.test/path?secret=1#fragment",
        $session_entry_referrer: "https://example.test/path?secret=1#fragment",
        $initial_referrer: "/relative?secret=1",
        $referrer: "file:///private/secret.txt",
        cta_id: "hero",
      },
    })

    expect(event.properties).toEqual({
      $current_url: "https://example.test/page",
      $session_entry_url: "https://example.test/path",
      $session_entry_referrer: "https://example.test/path",
      cta_id: "hero",
    })
  })
})
