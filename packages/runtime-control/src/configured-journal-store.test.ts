import { describe, expect, it } from "vitest"
import { createConfiguredJournalStore } from "./configured-journal-store"
import { R2ConditionalObjectStore } from "./r2-store"

const config = {
  schema: "lyrashield-supervisor-r2-journal-storage/1",
  accountId: "a".repeat(32),
  bucket: "private-journal-fixture",
  accessKeyId: "b".repeat(32),
  secretAccessKey: "c".repeat(64),
}
describe("protected supervisor journal storage factory", () => {
  it("constructs the existing bounded R2 adapter without performing a request", () => {
    const result = createConfiguredJournalStore(JSON.stringify(config))
    expect(result.store).toBeInstanceOf(R2ConditionalObjectStore)
    result.close()
  })
  it("permits bounded encrypted tool responses while rejecting an excessive read limit", () => {
    const result = createConfiguredJournalStore(JSON.stringify(config), 4 * 1024 * 1024)
    result.close()
    for (const maximum of [0, -1, 1.5, 4 * 1024 * 1024 + 1])
      expect(() => createConfiguredJournalStore(JSON.stringify(config), maximum)).toThrow(
        "Protected supervisor journal storage is unavailable"
      )
  })
  it.each([
    "{}",
    "not json",
    JSON.stringify({ ...config, endpoint: "http://caller.example" }),
    JSON.stringify({ ...config, secretAccessKey: "short" }),
    "x".repeat(4097),
  ])("rejects invalid installation with a fixed safe error", (input) => {
    expect(() => createConfiguredJournalStore(input)).toThrow(
      "Protected supervisor journal storage is unavailable"
    )
  })
})
