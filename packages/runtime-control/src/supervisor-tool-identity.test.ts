import { describe, expect, it } from "vitest"
import { deriveSupervisorToolJournalIdentity } from "./supervisor-tool-identity"

const identity = {
  streamId: "stream-test",
  authorityEpochId: "epoch-test",
  supervisorInstanceId: "supervisor-test",
  originalSigningSecret: "a".repeat(48),
  wrapperSigningSecret: "b".repeat(48),
}
describe("private tool journal identity", () => {
  it("binds independent stream keys and response encryption to the exact protected epoch and owner", () => {
    const keys = deriveSupervisorToolJournalIdentity(identity)
    expect(deriveSupervisorToolJournalIdentity(identity)).toEqual(keys)
    expect(keys.streamId).toBe("stream-test.tools")
    expect(keys.supervisorInstanceId).toBe("supervisor-test.tools")
    expect(
      new Set([
        keys.originalSigningSecret,
        keys.wrapperSigningSecret,
        keys.responseSecret,
        identity.originalSigningSecret,
        identity.wrapperSigningSecret,
      ]).size
    ).toBe(5)
    expect(
      deriveSupervisorToolJournalIdentity({ ...identity, authorityEpochId: "epoch-other" })
        .originalSigningSecret
    ).not.toBe(keys.originalSigningSecret)
    expect(
      deriveSupervisorToolJournalIdentity({ ...identity, supervisorInstanceId: "supervisor-other" })
        .originalSigningSecret
    ).not.toBe(keys.originalSigningSecret)
  })
  it("rejects aliases, weak keys and identities exceeding the independent namespace bound", () => {
    expect(() =>
      deriveSupervisorToolJournalIdentity({
        ...identity,
        wrapperSigningSecret: identity.originalSigningSecret,
      })
    ).toThrow()
    expect(() =>
      deriveSupervisorToolJournalIdentity({ ...identity, originalSigningSecret: "short" })
    ).toThrow()
    expect(() =>
      deriveSupervisorToolJournalIdentity({ ...identity, streamId: "a".repeat(123) })
    ).toThrow()
  })
})
