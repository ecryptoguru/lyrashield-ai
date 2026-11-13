import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const script = readFileSync(
  new URL("./rehearse-webhook-empty-state-trusted-v2.sh", import.meta.url),
  "utf8"
)

test("trusted PostgreSQL rehearsal waits for verified TCP/TLS readiness", () => {
  const start = script.indexOf("ready=false")
  const end = script.indexOf('if [[ "$ready" != true ]]')
  assert.ok(start >= 0 && end > start, "readiness retry loop is present")
  const readiness = script.slice(start, end)

  assert.match(readiness, /psql --no-psqlrc/)
  assert.match(readiness, /"\$pg_host"/)
  assert.match(readiness, /SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid\(\)/)
  assert.match(readiness, /\[\[ "\$tls_result" == t \]\]/)
  assert.doesNotMatch(readiness, /pg_isready/, "socket-only bootstrap readiness is insufficient")
  assert.match(script, /sslmode=verify-full sslrootcert=\/tmp\/fixture-ca\.crt/)
  assert.match(script, /Disposable PostgreSQL did not become ready over the verified TCP\/TLS path/)
})
