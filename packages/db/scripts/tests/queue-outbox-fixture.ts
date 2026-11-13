import { randomUUID } from "node:crypto"
import type pg from "pg"
import {
  enqueueScan,
  getScanQueue,
  registerScanWorker,
  unregisterScanWorker,
} from "../../../integrations/src/queue"
import { closeRedis } from "../../../integrations/src/redis"
import { buildScanQueuePayload, scanQueueDigest } from "../../src/scan-queue-payload"
import { createScanQueuePublicationProof } from "../../src/scan-queue-publication-proof"
import type { ScanQueueOutboxTransport } from "../../src/scan-queue-outbox-dispatcher"

export const fixtureQueueTransport: ScanQueueOutboxTransport = {
  publish: enqueueScan,
  async read(jobId) {
    const queue = getScanQueue()
    const job = await queue.getJob(jobId)
    if (!job) return null
    return {
      id: job.id!,
      queueName: queue.name,
      name: job.name,
      data: job.data,
      state: await job.getState(),
    }
  },
}

export function queueFixtureWorker() {
  const workerId = `queue-fixture-${randomUUID()}`
  return {
    open: () => registerScanWorker(workerId),
    async close() {
      await unregisterScanWorker(workerId)
      await getScanQueue().close()
      await closeRedis()
    },
  }
}

/** Synthetic fixture authority backed by actual enqueueScan and positive Redis readback. */
export async function publishFixtureOutbox(owner: pg.Pool, scanId: string, operationId: string) {
  const scan = (
    await owner.query(
      'SELECT id,"workspaceId","targetId",goal,mode,"policyId" FROM "Scan" WHERE id=$1',
      [scanId]
    )
  ).rows[0]
  const input = buildScanQueuePayload(scan)
  const outboxId = `queue-${randomUUID()}`
  const payloadDigest = scanQueueDigest(input)
  await owner.query(
    `INSERT INTO "ScanQueueOutbox"
    (id,"scanId","operationId","jobId","payloadDigest","payloadInputJson",state,"attempts","createdAt","updatedAt")
    VALUES ($1,$2,$3,$2,$4,$5,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [outboxId, scanId, operationId, payloadDigest, input]
  )
  await fixtureQueueTransport.publish(JSON.parse(input))
  const proof = createScanQueuePublicationProof(
    { outboxId, operationId, jobId: scanId, payloadDigest },
    input,
    await fixtureQueueTransport.read(scanId)
  )
  await owner.query(
    `UPDATE "ScanQueueOutbox" SET state='PUBLISHED',"publishedAt"=CURRENT_TIMESTAMP,
    "publicationReceiptInputJson"=$2,"publicationReceiptChecksum"=$3,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
    [outboxId, proof.input, proof.checksum]
  )
}
