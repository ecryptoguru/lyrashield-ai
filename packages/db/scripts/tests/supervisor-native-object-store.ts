import { createHash } from "node:crypto"
import { open, readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { BoundedConditionalObjectStore, StoredObject } from "@lyrashield/runtime-control"
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
/** Disposable durable filesystem port; this is not an R2-service qualification. */
export class NativeFixtureObjectStore implements BoundedConditionalObjectStore {
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string) {}
  private path(key: string) {
    return join(this.root, digest(key))
  }
  async read(key: string): Promise<StoredObject | null> {
    try {
      const bytes = await readFile(this.path(key))
      return { bytes, etag: digest(bytes) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }
  async readBounded(key: string, maxBytes: number) {
    const result = await this.read(key)
    if (result && result.bytes.length > maxBytes)
      throw new Error("fixture object exceeds read bound")
    return result
  }
  put(
    key: string,
    bytes: Uint8Array,
    condition: { ifNoneMatch: true } | { ifMatch: string }
  ): Promise<"written" | "conflict"> {
    const write = async () => {
      const old = await this.read(key)
      if (
        ("ifNoneMatch" in condition && old) ||
        ("ifMatch" in condition && old?.etag !== condition.ifMatch)
      )
        return "conflict" as const
      const path = this.path(key),
        temporary = path + ".pending"
      const file = await open(temporary, "w", 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
      const directory = await open(this.root, "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      return "written" as const
    }
    const result = this.serial.then(write)
    this.serial = result.catch(() => undefined)
    return result
  }
}
