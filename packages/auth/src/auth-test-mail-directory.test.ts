import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  cleanupOwnedAuthTestMailDirectory,
  createOwnedAuthTestMailDirectory,
} from "./auth-test-mail-directory"

const createdDirectories: string[] = []
const callerDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    [...createdDirectories, ...callerDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
  createdDirectories.length = 0
  callerDirectories.length = 0
})

describe("owned auth mail fixture directory", () => {
  it("overwrites caller paths and preserves their pre-existing contents during teardown", async () => {
    const callerDirectory = await mkdtemp(join(tmpdir(), "lyrashield-auth-mail-"))
    callerDirectories.push(callerDirectory)
    const sentinel = join(callerDirectory, "caller-data.txt")
    await writeFile(sentinel, "preserve")
    const environment: NodeJS.ProcessEnv = {
      LYRASHIELD_TEST_AUTH_MAIL_DIR: callerDirectory,
      LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR: callerDirectory,
    }

    const ownedDirectory = createOwnedAuthTestMailDirectory(environment)
    createdDirectories.push(ownedDirectory)
    expect(ownedDirectory).not.toBe(callerDirectory)
    expect(environment.LYRASHIELD_TEST_AUTH_MAIL_DIR).toBe(ownedDirectory)
    expect(environment.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR).toBe(ownedDirectory)

    await cleanupOwnedAuthTestMailDirectory(
      environment.LYRASHIELD_TEST_AUTH_MAIL_DIR,
      environment.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR
    )
    createdDirectories.length = 0
    expect(await readFile(sentinel, "utf8")).toBe("preserve")
  })

  it("refuses teardown for a caller path that lacks this run's ownership record", async () => {
    const callerDirectory = await mkdtemp(join(tmpdir(), "lyrashield-auth-mail-"))
    callerDirectories.push(callerDirectory)
    const sentinel = join(callerDirectory, "caller-data.txt")
    await writeFile(sentinel, "preserve")

    await expect(cleanupOwnedAuthTestMailDirectory(callerDirectory, undefined)).rejects.toThrow(
      "Refusing to remove an unowned mail fixture directory"
    )
    expect(await readFile(sentinel, "utf8")).toBe("preserve")
  })
})
