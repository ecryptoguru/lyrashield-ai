// The one-time maintenance path. No retry, recovery, rollback, cancellation,
// financial reconciliation, or scan replay is performed by this controller.
export async function runFirstV26Phase(phase, service) {
  switch (phase) {
    case "claim":
      await service.claim()
      break
    case "quiesce":
      await service.owned()
      await service.deactivate()
      await service.drain()
      await service.stop()
      await service.inactive()
      await service.inventory()
      break
    case "before-migrate":
      await service.inactive()
      await service.quiesced()
      await service.legacySchema()
      await service.accounting()
      await service.migrationIntent()
      // Close the observation-to-migration window without writing any work.
      await service.inactive()
      await service.owned()
      break
    case "after-migrate":
      await service.inactive()
      await service.owned()
      await service.grant()
      await service.postMigration()
      await service.migrated()
      break
    case "verify":
      await service.owned()
      await service.postMigration()
      await service.candidateFleet()
      await service.verified()
      break
    case "release":
      await service.candidateFleet()
      await service.postMigration()
      await service.release()
      break
    case "hold":
      // An absent or foreign stop must never deactivate a healthy completed
      // fleet or silently re-establish maintenance after admissions reopened.
      await service.owned()
      await service.deactivate()
      break
    default:
      throw new Error("Unsupported first-v26 maintenance phase")
  }
}
