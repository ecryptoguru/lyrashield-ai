import { readFileSync } from "node:fs"
export const PREPARATION_COMPLETION_MIGRATION = "20261113200000_supervisor_preparation_completion"
export const preparationCompletionSql = readFileSync(
  new URL(
    "../../packages/db/prisma/migrations/20261113200000_supervisor_preparation_completion/migration.sql",
    import.meta.url
  ),
  "utf8"
)
export const EXECUTION_ACTION_MIGRATION = "20261113163000_scan_execution_action_authority"
export const NATIVE_RESOLUTION_MIGRATION = "20261113181000_supervisor_native_invocation_resolution"
export const nativeResolutionSql = readFileSync(
  new URL(
    "../../packages/db/prisma/migrations/20261113181000_supervisor_native_invocation_resolution/migration.sql",
    import.meta.url
  ),
  "utf8"
)
export const EXECUTION_RECEIPT_MIGRATION = "20261113170000_supervisor_execution_receipts"
// Fixed reviewed sources only; these are not caller path or catalog allowlists.
// eslint-disable-next-line security/detect-non-literal-fs-filename
export const preparationSql = readFileSync(
  new URL(
    "../../packages/db/prisma/migrations/20261111130000_scan_preparation_authority_fence/migration.sql",
    import.meta.url
  ),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
export const executionSql = readFileSync(
  new URL(
    `../../packages/db/prisma/migrations/${EXECUTION_ACTION_MIGRATION}/migration.sql`,
    import.meta.url
  ),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
export const executionReceiptSql = readFileSync(
  new URL(
    `../../packages/db/prisma/migrations/${EXECUTION_RECEIPT_MIGRATION}/migration.sql`,
    import.meta.url
  ),
  "utf8"
)
export const executionTables = [
  "ScanExecutionActionIntent",
  "ScanExecutionInvocationGuard",
  "ScanExecutionInvocationResolution",
]
export const extraSources =
  preparationSql +
  executionSql +
  executionReceiptSql +
  nativeResolutionSql +
  preparationCompletionSql
export const sourceAttributes = new Map(
  [
    ...extraSources.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION app\.([a-z_]+)\([^]*?LANGUAGE (sql|plpgsql)([^]*?)AS \$\$/g
    ),
  ].map((match) => {
    const path = match[3].match(/SET search_path\s*=\s*([^]*?)\s*$/)?.[1]
    return [
      match[1],
      {
        language: match[2],
        definer: match[3].includes("SECURITY DEFINER"),
        ...(path
          ? {
              config: [
                `search_path=${path
                  .trim()
                  .split(/\s*,\s*/)
                  .join(", ")}`,
              ],
            }
          : {}),
      },
    ]
  })
)
export const writerTables = [
  ...new Set(
    [
      ...extraSources.matchAll(
        /FOREACH name IN ARRAY ARRAY\[([^\]]*)\] LOOP\s*EXECUTE format\('CREATE TRIGGER scan_preparation_writer_gate/g
      ),
    ].flatMap((match) => [...match[1].matchAll(/'([A-Za-z_]+)'/g)].map((name) => name[1]))
  ),
]

export function executionVerificationSql({
  functionContract,
  bodies,
  literal,
  tableArray,
  reachablePrivilege,
}) {
  const functions = [
    {
      name: "scan_supervisor_preparation_completed",
      arguments: "text",
      names: ["command_id"],
      result: "boolean",
    },
    { name: "scan_execution_gate_held", result: "boolean" },
    { name: "scan_execution_invocation_pending", result: "boolean" },
    { name: "require_scan_execution_action_role", result: "void" },
    {
      name: "check_scan_current_execution_authority",
      arguments: "text, timestamp without time zone, text",
      names: ["scan_id", "expires_at", "phase", "acceptedAt", "deadlineAt"],
      result: "record",
      returnsSet: true,
      argModes: ["i", "i", "i", "t", "t"],
      allArgTypes: [
        "text",
        "timestamp without time zone",
        "text",
        "timestamp without time zone",
        "timestamp without time zone",
      ],
    },
    {
      name: "check_scan_preparation_authority",
      arguments: "text, timestamp without time zone",
      names: ["scan_id", "expires_at", "acceptedAt", "deadlineAt"],
      result: "record",
      returnsSet: true,
      argModes: ["i", "i", "t", "t"],
      allArgTypes: [
        "text",
        "timestamp without time zone",
        "timestamp without time zone",
        "timestamp without time zone",
      ],
    },
  ]
  const checks = functions.map(
    (definition) => `EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
   JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language language ON language.oid=p.prolang
   WHERE ${functionContract("app", { ...sourceAttributes.get(definition.name), ...definition, body: bodies.get(definition.name) })}
)`
  )
  const writers = writerTables.map(
    (
      table
    ) => `EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
   JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language language ON language.oid=p.prolang
   WHERE t.tgrelid=${literal(`public.\"${table}\"`)}::regclass AND t.tgname='scan_preparation_writer_gate'
     AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=30 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
     AND ${functionContract("app", { name: "scan_preparation_writer_gate", result: "trigger", body: bodies.get("scan_preparation_writer_gate"), ...sourceAttributes.get("scan_preparation_writer_gate") })}
)`
  )
  return {
    checks: [...checks, ...writers].join(" AND "),
    tables: `(SELECT count(*)=3 AND bool_and(c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(${tableArray(executionTables)}))
   AND NOT EXISTS(SELECT 1 FROM unnest(${tableArray(executionTables)}) name, pg_catalog.pg_class c,
     LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
     WHERE c.oid=format('public.%I',name)::regclass AND a.grantee=0)`,
    denied(role) {
      return `NOT EXISTS(SELECT 1 FROM unnest(${tableArray(executionTables)}) name WHERE ${reachablePrivilege(role, "table", "format('public.%I',name)", "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN")})`
    },
  }
}
