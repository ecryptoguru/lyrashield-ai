import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SignedJournal,
  authorityEventSchema,
  canonicalJson,
  sha256Hex,
  type AuthorityEvent,
  type JournalRecord,
  type VerifiedJournalContinuation,
} from "@lyrashield/runtime-control"
import {
  supervisorJournalEventSchema,
  supervisorJournalRecordSchema,
  type SupervisorJournalEvent,
} from "./journal-events"
import { matchRetainedSupervisorCommand } from "./retained-command-continuation"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// This unit fixture supplies verified-state-shaped data. Gate and chain authentication are tested by runtime-control.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "retained-command-"))
  roots.push(root)
  const source = new SignedJournal(join(root, "original"), "o".repeat(48), (v) =>
    supervisorJournalEventSchema.parse(v)
  )
  const independent = new SignedJournal<AuthorityEvent<JournalRecord<SupervisorJournalEvent>>>(
    join(root, "wrapper"),
    "w".repeat(48),
    (v) => authorityEventSchema(supervisorJournalRecordSchema).parse(v)
  )
  const command = {
    type: "STOP" as const,
    commandId: "command-test-1",
    attemptId: "attempt-test-1",
    expectedReceiptHash: "0".repeat(64),
  }
  const base = { supervisorInstanceId: "supervisor-test-1", observedAt: "2026-11-12T00:00:00.000Z" }
  const original = [
    await source.append({ ...base, type: "command_intent", command }),
    await source.append({
      ...base,
      type: "command_terminal",
      commandId: command.commandId,
      attemptId: command.attemptId,
      status: "STOPPED",
    }),
  ]
  const wrappers = []
  for (const record of original)
    wrappers.push(
      await independent.append({
        epochId: "epoch-test-1",
        operationId: "operation-test-1",
        scanId: "scan-test-1",
        workspaceId: "workspace-test-1",
        attemptId: command.attemptId,
        eventId: `supervisor:${record.hash}`,
        payload: record,
      })
    )
  await source.close()
  await independent.close()
  const head = {
    schema: "lyrashield-independent-authority-head/1" as const,
    supervisorInstanceId: base.supervisorInstanceId,
    epochId: "epoch-test-1",
    operationId: "operation-test-1",
    scanId: "scan-test-1",
    workspaceId: "workspace-test-1",
    attemptId: command.attemptId,
    eventId: `supervisor:${original[1]!.hash}`,
    sequence: 2,
    previousHash: wrappers[1]!.previousHash,
    recordHash: wrappers[1]!.hash,
    signature: "a".repeat(64),
  }
  let active = true
  const state = {
    sealed: {
      epochId: head.epochId,
      supervisorInstanceId: head.supervisorInstanceId,
      firstSequence: 1,
      lastSequence: 1,
    },
    journalHead: head,
    sealedRecords: { originals: [original[0]!], wrappers: [wrappers[0]!] },
    originalTail: { records: [original[1]!] },
    wrapperTail: { records: [wrappers[1]!] },
    assertActive() {
      if (!active) throw new Error("fence closed")
    },
  } as unknown as VerifiedJournalContinuation<SupervisorJournalEvent>
  const commandInputJson = canonicalJson(command)
  const expected = {
    commandId: command.commandId,
    attemptId: command.attemptId,
    requestHash: sha256Hex(commandInputJson),
  }
  const history = {
    command,
    commandInputJson,
    requestHash: expected.requestHash,
    originalInputJson: canonicalJson(original[0]),
    wrapperInputJson: canonicalJson(wrappers[0]),
    statusOriginalInputJson: canonicalJson(original[1]),
    statusWrapperInputJson: canonicalJson(wrappers[1]),
    observedStatus: "STOPPED",
    headInputJson: canonicalJson(head),
    confirmedSequence: 2,
  }
  return {
    state,
    history,
    expected,
    original,
    wrappers,
    deactivate: () => {
      active = false
    },
  }
}

describe("retained supervisor command continuation", () => {
  it("matches exact intent in the current sealed segment and status in the verified tail", async () => {
    const f = await fixture()
    const matched = matchRetainedSupervisorCommand(f.state, f.history, f.expected)
    expect(matched.intent.original).toEqual(f.original[0])
    expect(matched.status.wrapper).toEqual(f.wrappers[1])
    expect(matched.observedStatus).toBe("STOPPED")
  })

  it("also accepts both signed records within the current sealed segment", async () => {
    const f = await fixture()
    f.state.sealed.lastSequence = 2
    f.state.sealedRecords.originals.push(f.original[1]!)
    f.state.sealedRecords.wrappers.push(f.wrappers[1]!)
    f.state.originalTail.records = []
    f.state.wrapperTail.records = []
    expect(matchRetainedSupervisorCommand(f.state, f.history, f.expected).status.original).toEqual(
      f.original[1]
    )
  })

  it("fails closed on stale heads, modified records, request or status", async () => {
    const f = await fixture()
    for (const history of [
      { ...f.history, headInputJson: `${f.history.headInputJson} ` },
      { ...f.history, confirmedSequence: 1 },
      { ...f.history, originalInputJson: `${f.history.originalInputJson} ` },
      { ...f.history, statusWrapperInputJson: `${f.history.statusWrapperInputJson} ` },
      { ...f.history, requestHash: "0".repeat(64) },
      { ...f.history, observedStatus: "UNKNOWN" },
    ])
      expect(() => matchRetainedSupervisorCommand(f.state, history, f.expected)).toThrow(
        /UNAVAILABLE/
      )
    expect(() =>
      matchRetainedSupervisorCommand(f.state, f.history, {
        ...f.expected,
        attemptId: "attempt-other",
      })
    ).toThrow(/UNAVAILABLE/)
  })

  it("does not claim records from an earlier seal or an inactive fence", async () => {
    const f = await fixture()
    f.state.sealed.firstSequence = 2
    expect(() => matchRetainedSupervisorCommand(f.state, f.history, f.expected)).toThrow(
      /UNAVAILABLE/
    )
    f.state.sealed.firstSequence = 1
    f.deactivate()
    expect(() => matchRetainedSupervisorCommand(f.state, f.history, f.expected)).toThrow(
      /fence closed/
    )
  })

  it("checks the continuation fence again before returning", async () => {
    const f = await fixture()
    let checks = 0
    f.state.assertActive = () => {
      if (++checks === 2) throw new Error("fence closed")
    }
    expect(() => matchRetainedSupervisorCommand(f.state, f.history, f.expected)).toThrow(
      /fence closed/
    )
    expect(checks).toBe(2)
  })
})
