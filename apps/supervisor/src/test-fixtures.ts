import type { ScanAuthorityFence } from "@lyrashield/runtime-control"
import type { SupervisorAuthorityJournal } from "./authority-journal"

// Synthetic lifecycle fixtures do not establish database authorization.
export const fixtureAuthorityFence: ScanAuthorityFence = {
  run: async (_binding, effect) => effect(() => undefined),
}

/** Models an older journal port that supports explicit recovery only. */
export function explicitRecoveryJournal(journal: SupervisorAuthorityJournal) {
  return {
    load: journal.load.bind(journal),
    append: journal.append.bind(journal),
    readCursor: journal.readCursor.bind(journal),
    recoverStored: journal.recoverStored.bind(journal),
  }
}
