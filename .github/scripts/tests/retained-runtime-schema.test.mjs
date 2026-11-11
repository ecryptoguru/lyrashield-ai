import assert from "node:assert/strict"
import test from "node:test"
import { verifyRetainedRuntimeSchema } from "../retained-runtime-schema.mjs"

const input = {
  principals: ["app_runtime", "scanner_runtime"],
  migration: {
    name: "20261105120000_delegated_scan_provenance",
    checksum: "a".repeat(64),
  },
}
function fixture() {
  const state = {
    recorded: [{ checksum: input.migration.checksum, finished: true, rolled_back: false }],
    policies: [
      {
        relrowsecurity: true,
        relforcerowsecurity: true,
        polname: "delegated_scan_provenance_workspace",
        polcmd: "*",
        polpermissive: true,
        roles: "{0}",
        using_expression: '("workspaceId" = app.current_workspace_id())',
        check_expression: '("workspaceId" = app.current_workspace_id())',
      },
    ],
    triggers: [
      {
        tgname: "delegated_scan_provenance_immutable",
        tgtype: 19,
        tgenabled: "O",
        unconditional: true,
        function_schema: "app",
        proname: "reject_delegated_scan_provenance_update",
        pronargs: 0,
        prosecdef: false,
        returns_trigger: true,
        prosrc:
          "\nBEGIN\n  RAISE EXCEPTION 'delegated scan provenance is immutable' USING ERRCODE = '23514';\nEND;\n",
      },
    ],
    grants: input.principals.map((rolname) => ({
      rolname,
      rolsuper: false,
      rolbypassrls: false,
      can_select: true,
      can_insert: true,
    })),
  }
  const calls = []
  const client = {
    async query(sql, args) {
      calls.push({ sql, args })
      if (state.failure && sql.includes(state.failure)) throw new Error("private catalog detail")
      if (sql.includes("_prisma_migrations")) return { rows: state.recorded }
      if (sql.includes("pg_catalog.pg_policy")) return { rows: state.policies }
      if (sql.includes("pg_catalog.pg_trigger")) return { rows: state.triggers }
      if (sql.includes("has_table_privilege")) return { rows: state.grants }
      return { rows: [] }
    },
  }
  return { state, calls, client }
}

test("observed producer principals need SELECT/INSERT; no runtime privilege is granted", async () => {
  const f = fixture()
  await verifyRetainedRuntimeSchema(f.client, input)
  assert.equal(f.calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  assert.equal(f.calls.at(-1).sql, "ROLLBACK")
  assert.ok(
    f.calls.every(({ sql }) => !/\b(GRANT|REVOKE|INSERT INTO|UPDATE |DELETE FROM)\b/.test(sql))
  )
  assert.deepEqual(f.calls.find(({ sql }) => sql.includes("has_table_privilege")).args, [
    input.principals,
  ])
})

test("every missing or drifted schema/privilege observation fails before promotion", async (t) => {
  const mutations = [
    ["migration absent", (s) => (s.recorded = [])],
    ["duplicate migration", (s) => s.recorded.push(s.recorded[0])],
    ["wrong checksum", (s) => (s.recorded[0].checksum = "b".repeat(64))],
    ["unfinished migration", (s) => (s.recorded[0].finished = false)],
    ["rolled back migration", (s) => (s.recorded[0].rolled_back = true)],
    ["missing table/policy", (s) => (s.policies = [])],
    ["additional policy", (s) => s.policies.push(s.policies[0])],
    ["RLS disabled", (s) => (s.policies[0].relrowsecurity = false)],
    ["forced RLS disabled", (s) => (s.policies[0].relforcerowsecurity = false)],
    ["policy name drift", (s) => (s.policies[0].polname = "other")],
    ["policy command drift", (s) => (s.policies[0].polcmd = "r")],
    ["policy mode drift", (s) => (s.policies[0].polpermissive = false)],
    ["policy role drift", (s) => (s.policies[0].roles = "{123}")],
    ["read scope drift", (s) => (s.policies[0].using_expression = "true")],
    ["write scope drift", (s) => (s.policies[0].check_expression = "true")],
    ["missing trigger", (s) => (s.triggers = [])],
    ["extra trigger", (s) => s.triggers.push(s.triggers[0])],
    ...[
      "tgname",
      "tgtype",
      "tgenabled",
      "unconditional",
      "function_schema",
      "proname",
      "pronargs",
      "prosecdef",
      "returns_trigger",
      "prosrc",
    ].map((field) => [`trigger ${field} drift`, (s) => (s.triggers[0][field] = null)]),
    ["missing role", (s) => s.grants.pop()],
    ["duplicate role", (s) => (s.grants[1] = s.grants[0])],
    ["unobserved role", (s) => (s.grants[1].rolname = "worker_runtime")],
    ["superuser role", (s) => (s.grants[0].rolsuper = true)],
    ["BYPASSRLS role", (s) => (s.grants[0].rolbypassrls = true)],
    ["missing SELECT", (s) => (s.grants[0].can_select = false)],
    ["missing INSERT", (s) => (s.grants[1].can_insert = false)],
    ["query error", (s) => (s.failure = "pg_catalog.pg_policy")],
    ["rollback error", (s) => (s.failure = "ROLLBACK")],
  ]
  for (const [name, mutate] of mutations)
    await t.test(name, async () => {
      const f = fixture()
      mutate(f.state)
      await assert.rejects(verifyRetainedRuntimeSchema(f.client, input))
      assert.equal(f.calls.at(-1).sql, "ROLLBACK")
    })
})

test("invalid identity inputs cannot reach the database", async () => {
  for (const invalid of [
    { ...input, principals: [] },
    { ...input, principals: ["app_runtime", "app_runtime"] },
    { ...input, principals: ["a".repeat(64)] },
    { ...input, migration: { ...input.migration, name: "other" } },
    { ...input, migration: { ...input.migration, checksum: "" } },
  ]) {
    const f = fixture()
    await assert.rejects(verifyRetainedRuntimeSchema(f.client, invalid))
    assert.equal(f.calls.length, 0)
  }
})
