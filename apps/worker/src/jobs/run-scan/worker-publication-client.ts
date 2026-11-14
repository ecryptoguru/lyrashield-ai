import { request } from "node:http"
import {
  queuePublicationVerificationInputSchema,
  queuePublicationVerificationResultSchema,
} from "@lyrashield/db/src/scan-queue-publication-verifier-schema"
import { serializeScanQueuePayload } from "@lyrashield/db/src/scan-queue-payload"
import type { WorkerBrokerInstallation } from "./broker-authority"

/** Public scoped worker credential only; publisher and database capabilities stay outside the worker. */
export function createWorkerBrokerPublicationVerifier(
  workerCredential: string
): WorkerBrokerInstallation["publication"] {
  if (
    typeof workerCredential !== "string" ||
    workerCredential.length < 32 ||
    workerCredential.length > 1024 ||
    workerCredential.trim() !== workerCredential ||
    /[\r\n]/.test(workerCredential)
  )
    throw new Error("Worker broker credential is unavailable")
  return {
    async verifyDispatch(scope, snapshot) {
      const input = queuePublicationVerificationInputSchema.parse({ ...scope, snapshot })
      const raw = JSON.stringify(input)
      if (Buffer.byteLength(raw) > 8192) throw new Error("Broker publication request is too large")
      const result = queuePublicationVerificationResultSchema.parse(
        await new Promise<unknown>((resolve, reject) => {
          const chunks: Buffer[] = []
          let total = 0,
            settled = false
          const req = request(
            {
              socketPath: "/run/lyrashield/broker.sock",
              method: "POST",
              path: `/operations/${input.operationId}/verify-publication`,
              headers: {
                authorization: `Bearer ${workerCredential}`,
                "content-type": "application/json",
                accept: "application/json",
              },
            },
            (response) => {
              if (response.statusCode !== 200) return finish(true)
              response.on("data", (part: Buffer) => {
                total += part.length
                if (total > 8192) return finish(true)
                chunks.push(part)
              })
              response.once("aborted", () => finish(true))
              response.once("error", () => finish(true))
              response.once("end", () => {
                try {
                  finish(false, JSON.parse(Buffer.concat(chunks).toString("utf8")))
                } catch {
                  finish(true)
                }
              })
            }
          )
          const timer = setTimeout(() => finish(true), 4000)
          function finish(failed: boolean, value?: unknown) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (failed) {
              req.destroy()
              reject(new Error("Broker publication is unavailable"))
            } else resolve(value)
          }
          req.once("error", () => finish(true))
          req.end(raw)
        })
      )
      if (
        result.kind === "published" &&
        (result.row.operationId !== input.operationId ||
          result.row.workspaceId !== input.workspaceId ||
          result.row.id !== snapshot.id ||
          result.row.payloadInputJson !== serializeScanQueuePayload(snapshot.data))
      )
        throw new Error("Broker publication scope differs")
      return result
    },
  }
}
