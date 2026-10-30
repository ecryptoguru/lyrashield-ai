import assert from "node:assert/strict"
import test from "node:test"
import { collectV26PostMigrationReadback } from "../v26-post-migration-readback.mjs"

const principals = ["runtime_app", "runtime_worker"]
const migrations = [
  { name: "20261030103000_scan_admission_capacity", checksum: "a".repeat(64) },
  { name: "20261030103100_scan_accounting_release", checksum: "b".repeat(64) },
  { name: "20261030104500_fix_pr_execution_identity", checksum: "c".repeat(64) },
  { name: "20261030110000_schedule_admission", checksum: "d".repeat(64) },
]
function client(mutator = () => {}) {
  const using = (id, setting) =>
    `("${id}" = NULLIF(current_setting('${setting}'::text, true), ''::text))`
  const policy = (name, polname, expression) => ({
    relname: name,
    relrowsecurity: true,
    relforcerowsecurity: true,
    polname,
    polcmd: "*",
    polpermissive: true,
    roles: "{0}",
    using_expression: expression,
    check_expression: expression,
  })
  const results = {
    role: [{ global_read: true }],
    migrations: migrations.map((item) => ({
      migration_name: item.name,
      checksum: item.checksum,
      finished: true,
      rolled_back: false,
    })),
    columns: Object.entries({
      "Scan.accountingVersion": "integer",
      "Scan.accountingSettledAt": "timestamp(3) without time zone",
      "PullRequest.executionKey": "text",
      "PullRequest.baseCommit": "text",
      "PullRequest.diffChecksum": "text",
      "PullRequest.approvalId": "text",
      "PullRequest.requestedById": "text",
      "PullRequest.credentialActor": "jsonb",
      "Schedule.lastScanId": "text",
      "Schedule.lastBlockedAt": "timestamp(3) without time zone",
      "Schedule.lastBlockedReason": "character varying(64)",
    }).map(([path, data_type]) => ({
      table_name: path.split(".")[0],
      column_name: path.split(".")[1],
      data_type,
    })),
    index: [
      {
        indisunique: true,
        indisvalid: true,
        indisready: true,
        nonpartial: true,
        definition:
          'CREATE UNIQUE INDEX "PullRequest_executionKey_key" ON public."PullRequest" USING btree ("executionKey")',
      },
    ],
    policies: [
      policy("UserScanSlot", "user_scan_slot_owner", using("userId", "app.current_scan_user_id")),
      policy(
        "ScanCapacityReservation",
        "scan_capacity_account_owner",
        using("accountId", "app.current_account_id")
      ),
    ],
    grants: principals.map((rolname) => ({
      rolname,
      rolsuper: false,
      rolbypassrls: false,
      crud: true,
    })),
    counts: [{ slots: "0", reservations: "0" }],
  }
  mutator(results)
  const calls = []
  return {
    calls,
    async query(sql) {
      calls.push(sql)
      if (sql.includes("global_read")) return { rows: results.role }
      if (sql.includes('public."_prisma_migrations"')) return { rows: results.migrations }
      if (sql.includes("format_type")) return { rows: results.columns }
      if (sql.includes("pg_catalog.pg_index")) return { rows: results.index }
      if (sql.includes("pg_catalog.pg_policy")) return { rows: results.policies }
      if (sql.includes("has_table_privilege")) return { rows: results.grants }
      if (sql.includes("AS slots")) return { rows: results.counts }
      return { rows: [] }
    },
  }
}

test("checks exact migrations, forced policies, runtime grants and zero seeds", async () => {
  const db = client()
  assert.deepEqual(await collectV26PostMigrationReadback(db, { principals, migrations }), {
    status: "NO_DETECTED_DB_BLOCKERS",
    cutoverReady: false,
  })
  assert.match(db.calls[0], /READ ONLY/)
  assert.match(db.calls.at(-1), /ROLLBACK/)
})

test("ambiguous or unsafe post-migration readback never authorizes a release", async () => {
  const changes = [
    (r) => {
      r.role[0].global_read = false
    },
    (r) => {
      r.migrations[0].checksum = "c".repeat(64)
    },
    (r) => {
      r.migrations[0].finished = false
    },
    (r) => {
      r.columns.pop()
    },
    (r) => {
      r.index[0].indisunique = false
    },
    (r) => {
      r.policies[0].relforcerowsecurity = false
    },
    (r) => {
      r.policies[0].using_expression = "true"
    },
    (r) => {
      r.policies.push(r.policies[0])
    },
    (r) => {
      r.grants[0].rolbypassrls = true
    },
    (r) => {
      r.grants[0].crud = false
    },
    (r) => {
      r.grants.pop()
    },
    (r) => {
      r.counts[0].reservations = "1"
    },
    (r) => {
      r.counts[0].slots = "1"
    },
  ]
  for (const change of changes) {
    const db = client(change)
    assert.deepEqual(await collectV26PostMigrationReadback(db, { principals, migrations }), {
      status: "REVIEW_REQUIRED",
      cutoverReady: false,
    })
    assert.match(db.calls.at(-1), /ROLLBACK/)
  }
})

test("missing identities and unrelated migrations fail closed", async () => {
  assert.equal(
    (await collectV26PostMigrationReadback(client(), { principals: [], migrations })).status,
    "REVIEW_REQUIRED"
  )
  assert.equal(
    (
      await collectV26PostMigrationReadback(client(), {
        principals,
        migrations: [{ name: "20260101000000_other", checksum: "a".repeat(64) }, migrations[1]],
      })
    ).status,
    "REVIEW_REQUIRED"
  )
})
