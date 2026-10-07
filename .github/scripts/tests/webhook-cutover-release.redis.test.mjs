import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const disposableUrl = process.env.WEBHOOK_RECOVERY_RELEASE_REDIS_URL
const require = createRequire(
  new URL("../../../packages/integrations/package.json", import.meta.url)
)
const source = readFileSync(".github/scripts/webhook-claims-vm.sh", "utf8")

test(
  "actual release Lua compare-deletes only the exact token on disposable Redis",
  {
    skip: !disposableUrl,
    timeout: 20_000,
  },
  async (t) => {
    const url = new URL(disposableUrl)
    assert.equal(url.protocol, "redis:")
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    assert.equal(url.search, "")
    const Redis = require(process.env.WEBHOOK_RECOVERY_REDIS_MODULE ?? "ioredis")
    const redis = new Redis(disposableUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 3_000,
    })
    const matches = [...source.matchAll(/redis\.eval\(("(?:\\.|[^"\\])*"|`[^`]*`)/g)]
    assert.equal(matches.length, 2, "both ordinary and recovery release scripts must be exercised")
    try {
      for (const [index, match] of matches.entries()) {
        const literal = match[1]
        assert.ok(!literal.includes("${"), "release Lua must be a fixed literal")
        const lua = literal.startsWith("`") ? literal.slice(1, -1) : JSON.parse(literal)
        await t.test(index === 0 ? "held recovery release" : "ordinary release", async () => {
          const key = `fixture:lyrashield:release:${randomUUID()}`
          const token = JSON.stringify({ owner: "fixture:1", runId: "fixture", at: randomUUID() })
          try {
            await redis.set(key, token)
            assert.equal(await redis.eval(lua, 1, key, token), 1)
            assert.equal(await redis.get(key), null)
            assert.equal(await redis.eval(lua, 1, key, token), 0)
            await redis.set(key, `${token}foreign`)
            assert.equal(await redis.eval(lua, 1, key, token), 0)
            assert.equal(await redis.get(key), `${token}foreign`)
          } finally {
            await redis.del(key)
          }
        })
      }
    } finally {
      await redis.quit()
    }
  }
)
