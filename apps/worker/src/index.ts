import { logger } from "@lyrashield/logger"

async function main() {
  logger.info("LyraShield worker starting", {
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  })

  // Worker queue setup will be added in Sprint 4
  logger.info("Worker ready (stub mode — scan jobs will be implemented in Sprint 4)")
}

main().catch((error) => {
  logger.error("Worker failed to start", { error: String(error) })
  process.exit(1)
})
