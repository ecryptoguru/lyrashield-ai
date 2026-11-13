import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  EXECUTION_ACTION_MIGRATION,
  EXECUTION_RECEIPT_MIGRATION,
  executionSql,
  preparationSql,
  nativeResolutionSql,
  NATIVE_RESOLUTION_MIGRATION,
  PREPARATION_COMPLETION_MIGRATION,
  preparationCompletionSql,
  executionReceiptSql,
  extraSources,
  executionTables,
  sourceAttributes,
  writerTables,
  executionVerificationSql,
} from "./restore-execution-authority-contract.mjs"

export const DISPATCH_MIGRATION = "20261105130000_durable_dispatch_authority"
export const POLICY_AUTHORITY_MIGRATION = "20261113130000_scan_policy_authority_v2"
export const COMMAND_DESCRIPTOR_MIGRATION = "20261113140000_scan_dispatch_command_descriptor"
export const SUPERVISOR_RECEIPT_MIGRATION = "20261113150000_supervisor_receipt_ingestion"
// Offline linux/arm64 fixture qualification, not a production/provider version allowance.
// Its fresh PG17.11 catalog contains no SECURITY DEFINER functions, also after installing the
// checked-out pgcrypto/btree_gist extensions. No system-definer identity is therefore allowlisted.
// Additional images/versions or definer extensions require separate catalog qualification.
export const RESTORE_AUTHORITY_POSTGRES_IMAGE =
  "sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb"
export const RESTORE_AUTHORITY_POSTGRES_VERSION = 170011
// Only fixed checked-out SQL, never caller-controlled paths, owns these expectations.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const dispatchSql = readFileSync(
  new URL(
    `../../packages/db/prisma/migrations/${DISPATCH_MIGRATION}/migration.sql`,
    import.meta.url
  ),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const policySql = readFileSync(
  new URL(
    `../../packages/db/prisma/migrations/${POLICY_AUTHORITY_MIGRATION}/migration.sql`,
    import.meta.url
  ),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const descriptorSql = readFileSync(
  new URL(
    `../../packages/db/prisma/migrations/${COMMAND_DESCRIPTOR_MIGRATION}/migration.sql`,
    import.meta.url
  ),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const receiptSql = readFileSync(
  new URL(
    `../../packages/db/prisma/migrations/${SUPERVISOR_RECEIPT_MIGRATION}/migration.sql`,
    import.meta.url
  ),
  "utf8"
)
const privateReceiptTables = ["ScanSupervisorJournalStream", "ScanSupervisorJournalRecord"]
const receiptConfigs = new Map(
  [
    ...receiptSql.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION app\.([a-z_]+)\([^]*?LANGUAGE plpgsql SET search_path\s*=\s*([^]*?) AS \$\$/g
    ),
  ].map((match) => [
    match[1],
    [
      `search_path=${match[2]
        .trim()
        .split(/\s*,\s*/)
        .join(", ")}`,
    ],
  ])
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const mirrorSql = readFileSync(
  new URL("../../packages/runtime-control/sql/authority-mirror.sql", import.meta.url),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const rlsSql = readFileSync(
  new URL(
    "../../packages/db/prisma/migrations/20260705100000_batch3_rls/migration.sql",
    import.meta.url
  ),
  "utf8"
)
const rlsHelperBody = rlsSql.match(
  /CREATE OR REPLACE FUNCTION app\.current_workspace_id\(\)[^]*?AS \$\$([^]*?)\$\$;/
)?.[1]
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const literal = (value) => "'" + value.replaceAll("'", "''") + "'"
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

export class RestoreAuthorityError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
export function requireCheck(value, code) {
  if (value !== true) throw new RestoreAuthorityError(code)
}
function roleName(value) {
  requireCheck(typeof value === "string" && identifier.test(value), "INVALID_CONFIGURATION")
  return value
}
function roles(values) {
  requireCheck(
    Array.isArray(values) && values.length > 0 && values.length <= 16,
    "INVALID_CONFIGURATION"
  )
  const result = values.map(roleName)
  requireCheck(new Set(result).size === result.length, "INVALID_CONFIGURATION")
  return result
}
function keys(value, allowed) {
  requireCheck(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.includes(key)),
    "INVALID_CONFIGURATION"
  )
}
function target(value) {
  keys(value, ["containerId", "ownerToken", "database"])
  requireCheck(
    /^[a-f0-9]{64}$/.test(value.containerId ?? "") &&
      /^[a-f0-9-]{36}$/.test(value.ownerToken ?? "") &&
      ["lyrashield_restore", "lyrashield_authority_restore"].includes(value.database),
    "INVALID_CONFIGURATION"
  )
}
/** No URLs, connection overrides or authority-enable options are accepted. */
export function validateRestoreAuthorityConfig(config) {
  keys(config, ["schema", "dispatch", "mirror"])
  requireCheck(config.schema === "lyrashield-offline-authority-restore/1", "INVALID_CONFIGURATION")
  keys(config.dispatch, ["target", "deniedRoles"])
  target(config.dispatch.target)
  roles(config.dispatch.deniedRoles)
  if (config.mirror !== undefined) {
    keys(config.mirror, ["target", "runtimeRole", "deniedRoles", "retainedJournal"])
    target(config.mirror.target)
    roleName(config.mirror.runtimeRole)
    roles(config.mirror.deniedRoles)
    requireCheck(
      !config.mirror.deniedRoles.includes(config.mirror.runtimeRole),
      "INVALID_CONFIGURATION"
    )
    // A public/app archive is never accepted as evidence for this separate schema.
    requireCheck(
      config.dispatch.target.containerId !== config.mirror.target.containerId ||
        config.dispatch.target.database !== config.mirror.target.database,
      "MIRROR_TARGET_NOT_INDEPENDENT"
    )
    keys(config.mirror.retainedJournal, ["path", "sha256"])
    requireCheck(
      typeof config.mirror.retainedJournal.path === "string" &&
        config.mirror.retainedJournal.path.startsWith("/") &&
        /^[a-f0-9]{64}$/.test(config.mirror.retainedJournal.sha256 ?? ""),
      "INVALID_CONFIGURATION"
    )
  }
  return config
}

export const dispatchTables = [...dispatchSql.matchAll(/CREATE TABLE "([A-Za-z]+)"/g)].map(
  (match) => match[1]
)
const bodies = new Map(
  [
    ...(
      dispatchSql +
      preparationSql +
      policySql +
      descriptorSql +
      receiptSql +
      executionSql +
      executionReceiptSql +
      nativeResolutionSql +
      preparationCompletionSql
    ).matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.([a-z_]+)\([^]*?AS \$\$([^]*?)\$\$;/g),
  ].map((match) => [match[1], match[2]])
)
const dispatchHelpers = [
  {
    name: "scan_attachment_ids_valid",
    arguments: "text[]",
    names: ["ids"],
    result: "boolean",
    volatility: "i",
    strict: true,
  },
  { name: "scan_target_snapshot_digest", arguments: "text", names: ["target_id"] },
  { name: "scan_policy_digest", arguments: "text", names: ["policy_id"] },
  {
    name: "scan_dispatch_command_input_valid",
    arguments: "text, text, text",
    names: ["input_json", "checksum", "command_digest"],
    result: "boolean",
    volatility: "i",
  },
  { name: "scan_dispatch_scope_digest", arguments: "text", names: ["scan_id"] },
]
const triggers = [
  ...(
    dispatchSql +
    preparationSql +
    policySql +
    descriptorSql +
    receiptSql +
    executionSql +
    executionReceiptSql +
    nativeResolutionSql +
    preparationCompletionSql
  ).matchAll(
    /CREATE TRIGGER ([a-z_]+)\s+BEFORE ((?:INSERT|UPDATE|DELETE)(?: OR (?:INSERT|UPDATE|DELETE)){0,2}) ON "([A-Za-z]+)"\s+FOR EACH ROW EXECUTE FUNCTION app\.([a-z_]+)\(\);/g
  ),
].map((match) => ({
  name: match[1],
  table: match[3],
  function: match[4],
  type: match[2]
    .split(" OR ")
    .reduce((type, event) => type | { INSERT: 4, DELETE: 8, UPDATE: 16 }[event], 3),
}))
const deferredBundle = extraSources.match(
  /CREATE CONSTRAINT TRIGGER ([a-z_]+) AFTER INSERT ON "([A-Za-z]+)"\s+DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app\.([a-z_]+)\(\);/
)
requireCheck(Boolean(deferredBundle), "SOURCE_CONTRACT_UNAVAILABLE")
triggers.push({
  name: deferredBundle[1],
  table: deferredBundle[2],
  function: deferredBundle[3],
  type: 5,
  deferred: true,
})
requireCheck(
  dispatchTables.length === 11 &&
    triggers.length === 43 &&
    writerTables.length === 20 &&
    triggers.every((trigger) => bodies.has(trigger.function)) &&
    dispatchHelpers.every((helper) => bodies.has(helper.name)),
  "SOURCE_CONTRACT_UNAVAILABLE"
)
requireCheck(typeof rlsHelperBody === "string", "SOURCE_CONTRACT_UNAVAILABLE")
const tableArray = (names) => `ARRAY[${names.map((name) => literal(name)).join(",")}]::text[]`
const allPrivileges = "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN"
function restrictedRole(role) {
  return `EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=${literal(role)} AND
    NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) AND
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles parent WHERE
      (parent.rolsuper OR parent.rolbypassrls OR parent.rolcreaterole OR parent.rolcreatedb)
      AND pg_catalog.pg_has_role(r.oid,parent.oid,'MEMBER')))`
}
// MEMBER also covers NOINHERIT memberships: SET ROLE must not recover denied authority.
function reachablePrivilege(role, kind, object, privileges) {
  return `EXISTS (SELECT 1 FROM pg_catalog.pg_roles reachable WHERE
    pg_catalog.pg_has_role(${literal(role)},reachable.oid,'MEMBER') AND
    pg_catalog.has_${kind}_privilege(reachable.oid,${object},${literal(privileges)}))`
}
// Match reviewed catalog attributes as well as source bytes, including argument names used by
// PL/pgSQL/SQL bodies. This is a bounded source/permission check, not proof against dynamic SQL,
// mutable dependencies, or changes after this read-only snapshot.
function functionContract(schema, definition) {
  const {
    name,
    body,
    arguments: args = "",
    names,
    result = "text",
    language = "plpgsql",
    volatility = "v",
    strict = false,
    definer = false,
    config,
    returnsSet = false,
    argModes,
    allArgTypes,
  } = definition
  return `n.nspname=${literal(schema)} AND p.proname=${literal(name)}
    AND pg_catalog.oidvectortypes(p.proargtypes)=${literal(args)}
    AND p.proargnames ${names ? `=${tableArray(names)}` : "IS NULL"}
    AND p.prorettype=${literal(result)}::regtype AND p.proretset=${returnsSet} AND p.prokind='f'
    AND p.proargmodes ${argModes ? `=ARRAY[${argModes.map(literal).join(",")}]::"char"[]` : "IS NULL"}
    AND p.proallargtypes ${allArgTypes ? `=ARRAY[${allArgTypes.map((type) => `${literal(type)}::regtype`).join(",")}]::oid[]` : "IS NULL"} AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.provariadic=0
    AND p.protrftypes IS NULL AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL
    AND p.provolatile=${literal(volatility)} AND p.proisstrict=${strict}
    AND NOT p.proleakproof AND p.proparallel='u' AND p.procost=100 AND p.prorows=${returnsSet ? 1000 : 0}
    AND p.prosecdef=${definer} AND p.proconfig ${config ? `=${tableArray(config)}` : "IS NULL"}
    AND language.lanname=${literal(language)} AND p.prosrc=${literal(body)}`
}
// EXECUTE is deliberately checked even without current schema USAGE: a subsequent USAGE grant
// must not uncover an unreviewed definer. MEMBER includes inherited and SET ROLE permissions;
// has_function_privilege also includes PUBLIC. No caller-provided SQL allowlist is accepted.
function reviewedDefinersOnly(role, approved = "false") {
  return `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language language ON language.oid=p.prolang
    WHERE p.prosecdef
      AND ${reachablePrivilege(role, "function", "p.oid", "EXECUTE")}
      AND (${approved}) IS NOT TRUE)`
}
// An empty reviewed system-definer catalog is rechecked after restore, even for functions that
// currently have no runtime EXECUTE grant. Namespace spelling never creates a trust exemption.
const systemDefinersAbsent = `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE p.prosecdef AND (n.nspname ~ '^pg_' OR n.nspname='information_schema'))`
// Signature lookup does not model call resolution through default/variadic arguments. Admit
// only the two reviewed pgcrypto signatures across every schema in the probe search path.
const digestCatalog = `(SELECT count(*)=2 AND bool_and(COALESCE(
    n.nspname='public' AND p.proargtypes IN ('17 25'::oidvector,'25 25'::oidvector)
    AND p.prorettype=17 AND NOT p.proretset AND p.prokind='f'
    AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.provariadic=0
    AND p.proargmodes IS NULL AND p.proallargtypes IS NULL
    AND language.lanname='c' AND p.prosrc='pg_digest' AND p.probin='$libdir/pgcrypto'
    AND NOT p.prosecdef AND p.proisstrict AND p.provolatile='i' AND p.proparallel='s'
    AND p.proconfig IS NULL AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
      JOIN pg_catalog.pg_namespace extension_schema ON extension_schema.oid=e.extnamespace
      WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
        AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjsubid=0 AND d.deptype='e'
        AND e.extname='pgcrypto' AND e.extversion='1.3' AND extension_schema.nspname='public'),false))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_catalog.pg_language language ON language.oid=p.prolang
  WHERE p.proname='digest' AND n.nspname IN ('pg_catalog','public'))`
export function dispatchVerificationSql(deniedRoles) {
  roles(deniedRoles)
  const triggerChecks = triggers
    .map(
      (trigger) => `EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_language language ON language.oid=p.prolang
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE t.tgrelid=${literal(`public."${trigger.table}"`)}::regclass
      AND t.tgname=${literal(trigger.name)} AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgdeferrable=${Boolean(trigger.deferred)} AND t.tginitdeferred=${Boolean(trigger.deferred)}
      AND ${trigger.deferred ? "t.tgconstraint<>0" : "t.tgconstraint=0"}
      AND t.tgtype=${trigger.type} AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
      AND ${functionContract("app", { name: trigger.function, body: bodies.get(trigger.function), result: "trigger", config: receiptConfigs.get(trigger.function), ...sourceAttributes.get(trigger.function) })})`
    )
    .join(" AND ")
  const helpers = dispatchHelpers
    .map(
      (helper) => `EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language language ON language.oid=p.prolang
    WHERE ${functionContract("app", { result: "text", language: "sql", volatility: "s", ...helper, body: bodies.get(helper.name) })})`
    )
    .join(" AND ")
  const execution = executionVerificationSql({
    functionContract,
    bodies,
    literal,
    tableArray,
    reachablePrivilege,
  })
  const receiptTables = `
      (SELECT count(*)=2 AND bool_and(c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY(${tableArray(privateReceiptTables)}))
      AND NOT EXISTS(SELECT 1 FROM unnest(${tableArray(privateReceiptTables)}) name,
        pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
        WHERE c.oid=format('public.%I',name)::regclass AND acl.grantee=0)
      AND (SELECT count(*)=3 AND bool_and(a.atttypid='text'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attgenerated='')
        FROM pg_catalog.pg_attribute a WHERE a.attrelid='public."ScanSupervisorReceipt"'::regclass
          AND a.attname IN ('journalRecordId','eventType','terminalStatus'))
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='public."ScanSupervisorReceipt"'::regclass
        AND c.conname='ScanSupervisorReceipt_source_check' AND c.contype='c' AND c.convalidated)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        JOIN pg_catalog.pg_language language ON language.oid=p.prolang JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE t.tgrelid='public."ScanDispatchOutbox"'::regclass AND t.tgname='scan_checked_prepare_command'
          AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=23 AND t.tgqual IS NULL
          AND ${functionContract("app", { name: "scan_checked_prepare_command", body: bodies.get("scan_checked_prepare_command"), result: "trigger", config: receiptConfigs.get("scan_checked_prepare_command") })})`
  const roleChecks = deniedRoles
    .map(
      (role) => `${restrictedRole(role)}
    AND pg_catalog.has_schema_privilege(${literal(role)},'public','USAGE')
    AND pg_catalog.has_schema_privilege(${literal(role)},'app','USAGE')
    AND pg_catalog.has_table_privilege(${literal(role)},'public."Policy"','SELECT')
    AND pg_catalog.has_function_privilege(${literal(role)},'app.scan_policy_digest(text)','EXECUTE')
    AND pg_catalog.has_function_privilege(${literal(role)},'app.current_workspace_id()','EXECUTE')
    AND pg_catalog.has_function_privilege(${literal(role)},'public.digest(bytea,text)','EXECUTE')
    AND NOT EXISTS (
    SELECT 1 FROM unnest(${tableArray([...dispatchTables, ...privateReceiptTables, ...executionTables])}) name WHERE
      ${reachablePrivilege(role, "table", "format('public.%I',name)", allPrivileges)})`
    )
    .join(" AND ")
  return `SELECT json_build_object(
    'migration', (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(dispatchSql))}
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
      FROM public."_prisma_migrations" WHERE migration_name=${literal(DISPATCH_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(policySql))}
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
      FROM public."_prisma_migrations" WHERE migration_name=${literal(POLICY_AUTHORITY_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(descriptorSql))}
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
       FROM public."_prisma_migrations" WHERE migration_name=${literal(COMMAND_DESCRIPTOR_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(receiptSql))}
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
       FROM public."_prisma_migrations" WHERE migration_name=${literal(SUPERVISOR_RECEIPT_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(executionSql))} AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
       FROM public."_prisma_migrations" WHERE migration_name=${literal(EXECUTION_ACTION_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(executionReceiptSql))} AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
       FROM public."_prisma_migrations" WHERE migration_name=${literal(EXECUTION_RECEIPT_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(nativeResolutionSql))} AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
        FROM public."_prisma_migrations" WHERE migration_name=${literal(NATIVE_RESOLUTION_MIGRATION)}) AND
      (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(preparationCompletionSql))} AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
        FROM public."_prisma_migrations" WHERE migration_name=${literal(PREPARATION_COMPLETION_MIGRATION)}),
    'tables', (SELECT count(*)=11 AND bool_and(c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY(${tableArray(dispatchTables)})) AND
      (SELECT count(*)=3 AND bool_and(a.attnotnull AND NOT a.attisdropped AND a.attgenerated='' AND
        a.atttypid=CASE WHEN a.attname='authorityIncarnation' THEN 'text'::regtype ELSE 'int4'::regtype END)
       FROM pg_catalog.pg_attribute a
       WHERE (a.attrelid='public.\"Policy\"'::regclass AND a.attname IN ('authorityIncarnation','authorityRevision'))
          OR (a.attrelid='public.\"Scan\"'::regclass AND a.attname='policyBindingRevision')) AND
      (SELECT count(*)=2 AND bool_and(c.contype='c' AND c.convalidated AND NOT c.connoinherit AND
        pg_catalog.pg_get_constraintdef(c.oid)=CASE c.conname
          WHEN 'Policy_authorityRevision_positive' THEN 'CHECK ((\"authorityRevision\" > 0))'
          ELSE 'CHECK ((\"policyBindingRevision\" > 0))' END)
       FROM pg_catalog.pg_constraint c
       WHERE (c.conrelid='public.\"Policy\"'::regclass AND c.conname='Policy_authorityRevision_positive')
          OR (c.conrelid='public.\"Scan\"'::regclass AND c.conname='Scan_policyBindingRevision_positive')) AND
      (SELECT count(*)=2 AND bool_and(a.atttypid='text'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attgenerated='')
       FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.\"ScanDispatchOutbox\"'::regclass
         AND a.attname IN ('commandInputJson','commandInputChecksum')) AND
      EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.\"ScanDispatchOutbox\"'::regclass
        AND c.conname='ScanDispatchOutbox_command_input_check' AND c.contype='c' AND c.convalidated AND NOT c.connoinherit
        AND pg_catalog.pg_get_constraintdef(c.oid)='CHECK (app.scan_dispatch_command_input_valid(\"commandInputJson\", \"commandInputChecksum\", \"commandDigest\"))'),
    'triggers', ${triggerChecks},
    'receipts', ${receiptTables},
    'execution', ${execution.tables} AND ${execution.checks},
    'helpers', ${helpers} AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language language ON language.oid=p.prolang
      WHERE ${functionContract("app", { name: "current_workspace_id", result: "text", language: "sql", volatility: "s", body: rlsHelperBody, config: ["search_path=pg_catalog, app"] })}),
    'extension', ${digestCatalog},
    'systemDefiners', ${systemDefinersAbsent},
    'privilegedFunctions', ${deniedRoles.map((role) => reviewedDefinersOnly(role)).join(" AND ")},
    'closed', NOT EXISTS (SELECT 1 FROM public."ScanAuthorityEpoch" WHERE "isOpen" OR "openKey" IS NOT NULL OR "closedAt" IS NULL)
      AND EXISTS (SELECT 1 FROM public."ScanAuthorityEpoch" WHERE id='scan-authority-baseline' AND epoch=1
        AND NOT "isOpen" AND "openKey" IS NULL AND "openedAt" IS NULL AND "closedAt" IS NOT NULL),
    'roles', ${roleChecks})::text;`
}

/** Trusted synthetic fixture probe only; the standalone diagnostic must never execute it. */
export function dispatchDigestProbeSql(role) {
  roleName(role)
  // PostgreSQL jsonb::text uses this canonical spacing. The NULL policy branch always hashes
  // these synthetic bytes, including on an empty database, and never returns restored row data.
  const expected = sha256('{"schemaVersion": "scan-policy/none/2"}')
  const resolved = `(pg_catalog.to_regprocedure('digest(bytea,text)')='public.digest(bytea,text)'::regprocedure AND ${digestCatalog})`
  // SQL CASE does not prevent helper inlining during planning. Plan the fixed helper query
  // only after the catalog gate; a transaction-local setting carries synthetic booleans only.
  return `SET LOCAL ROLE ${literal(role)};
    SET LOCAL row_security=on; SET LOCAL search_path=pg_catalog,public;
    DO $restore_probe$
    DECLARE resolved boolean; matches boolean;
    BEGIN
      resolved := ${resolved};
      IF resolved THEN
        EXECUTE ${literal(`SELECT app.scan_policy_digest(NULL::text)=${literal(expected)}`)} INTO matches;
      END IF;
      PERFORM pg_catalog.set_config('lyrashield.restore_digest_probe',
        pg_catalog.json_build_object('resolution',resolved,'digest',matches)::text,true);
    END;
    $restore_probe$;
    SELECT pg_catalog.current_setting('lyrashield.restore_digest_probe');`
}

const mirrorFunctions = [
  ...mirrorSql.matchAll(
    /CREATE FUNCTION lyrashield_authority\.([a-z_]+)\([^]*?AS \$\$([^]*?)\$\$;/g
  ),
].map((match) => ({ name: match[1], body: match[2] }))
const mirrorArguments = {
  read_head: { arguments: "text, text", names: ["p_epoch", "p_supervisor"] },
  read_record: {
    arguments: "text, text, bigint",
    names: ["p_epoch", "p_supervisor", "p_sequence"],
  },
  append_record: {
    arguments: "text, text, text, text, text",
    names: ["p_epoch", "p_supervisor", "p_previous", "p_head", "p_record"],
  },
}
requireCheck(mirrorFunctions.length === 3, "SOURCE_CONTRACT_UNAVAILABLE")
export function mirrorVerificationSql(runtimeRole, deniedRoles) {
  roleName(runtimeRole)
  roles(deniedRoles)
  const approved = mirrorFunctions
    .map(
      ({ name, body }) =>
        `(${functionContract("lyrashield_authority", { name, body, ...mirrorArguments[name], definer: true, config: ["search_path=pg_catalog"] })})`
    )
    .join(" OR ")
  const functions = mirrorFunctions
    .map(
      ({ name, body }) => `EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language language ON language.oid=p.prolang
    WHERE ${functionContract("lyrashield_authority", { name, body, ...mirrorArguments[name], definer: true, config: ["search_path=pg_catalog"] })}
      AND NOT pg_catalog.pg_has_role(${literal(runtimeRole)},p.proowner,'MEMBER')
      AND pg_catalog.has_function_privilege(${literal(runtimeRole)},p.oid,'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee=0 OR (a.is_grantable AND CASE WHEN a.grantee<>0
          THEN pg_catalog.pg_has_role(${literal(runtimeRole)},a.grantee,'MEMBER') ELSE false END)))`
    )
    .join(" AND ")
  const denied = deniedRoles
    .map(
      (role) => `${restrictedRole(role)} AND
    NOT ${reachablePrivilege(role, "schema", "'lyrashield_authority'", "USAGE,CREATE")} AND
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='lyrashield_authority' AND ${reachablePrivilege(role, "function", "p.oid", "EXECUTE")}) AND
    NOT EXISTS (SELECT 1 FROM unnest(ARRAY['stream','record']) name WHERE
      ${reachablePrivilege(role, "table", "format('lyrashield_authority.%I',name)", allPrivileges)})`
    )
    .join(" AND ")
  return `SELECT json_build_object(
    'protected', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='lyrashield_authority'
      AND NOT pg_catalog.pg_has_role(${literal(runtimeRole)},n.nspowner,'MEMBER')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE a.grantee=0))
      AND (SELECT count(*)=2 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='lyrashield_authority' AND c.relname IN ('stream','record') AND c.relkind='r'
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)),
    'functions', ${functions},
    'systemDefiners', ${systemDefinersAbsent},
    'privilegedFunctions', ${reviewedDefinersOnly(runtimeRole, approved)} AND ${deniedRoles.map((role) => reviewedDefinersOnly(role)).join(" AND ")},
    'roles', ${restrictedRole(runtimeRole)} AND pg_catalog.has_schema_privilege(${literal(runtimeRole)},'lyrashield_authority','USAGE')
      AND NOT ${reachablePrivilege(runtimeRole, "schema", "'lyrashield_authority'", "CREATE")}
      AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['stream','record']) name WHERE
        ${reachablePrivilege(runtimeRole, "table", "format('lyrashield_authority.%I',name)", allPrivileges)}) AND ${denied},
    'closed', NOT EXISTS (SELECT 1 FROM lyrashield_authority.stream WHERE active))::text;`
}

/** Retained files must be authenticated independently; SHA256 binds bytes, not issuer authority. */
export function parseRetainedJournal(bytes, expectedSha256) {
  requireCheck(
    bytes.length <= 8 * 1024 * 1024 && sha256(bytes) === expectedSha256,
    "RETAINED_JOURNAL_BINDING"
  )
  const journal = JSON.parse(bytes)
  keys(journal, ["schema", "streams"])
  requireCheck(
    journal.schema === "lyrashield-restore-retained-journal/1" &&
      Array.isArray(journal.streams) &&
      journal.streams.length > 0 &&
      journal.streams.length <= 16,
    "RETAINED_JOURNAL_BINDING"
  )
  const seen = new Set()
  for (const stream of journal.streams) {
    keys(stream, ["epochId", "supervisorId", "headBytes", "records"])
    requireCheck(
      [stream.epochId, stream.supervisorId].every(
        (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
      ) &&
        typeof stream.headBytes === "string" &&
        stream.headBytes.length > 0 &&
        Array.isArray(stream.records) &&
        stream.records.length > 0 &&
        stream.records.length <= 1000,
      "RETAINED_JOURNAL_BINDING"
    )
    const identity = JSON.stringify([stream.epochId, stream.supervisorId])
    requireCheck(!seen.has(identity), "RETAINED_JOURNAL_BINDING")
    seen.add(identity)
    stream.records.forEach((record, index) => {
      keys(record, ["sequence", "recordBytes"])
      requireCheck(
        record.sequence === index + 1 &&
          typeof record.recordBytes === "string" &&
          record.recordBytes.length > 0,
        "RETAINED_JOURNAL_BINDING"
      )
    })
  }
  return journal
}
export function retainedJournalSql(stream) {
  return `SELECT json_build_object('headBytes',
    (SELECT head_bytes FROM lyrashield_authority.stream WHERE epoch_id=${literal(stream.epochId)} AND supervisor_id=${literal(stream.supervisorId)}),
    'records', COALESCE((SELECT json_agg(json_build_object('sequence',sequence,'recordBytes',record_bytes) ORDER BY sequence)
      FROM lyrashield_authority.record WHERE epoch_id=${literal(stream.epochId)} AND supervisor_id=${literal(stream.supervisorId)}),'[]'::json))::text;`
}
export function assertRetainedJournal(stream, observed) {
  requireCheck(
    observed?.headBytes === stream.headBytes &&
      Array.isArray(observed.records) &&
      observed.records.length === stream.records.length &&
      stream.records.every(
        (record, index) =>
          observed.records[index]?.sequence === record.sequence &&
          observed.records[index]?.recordBytes === record.recordBytes
      ),
    "RETAINED_JOURNAL_MISMATCH"
  )
}
export function assertRestoredChecks(observed, required) {
  requireCheck(
    observed !== null &&
      typeof observed === "object" &&
      required.every((key) => observed[key] === true),
    "RESTORED_AUTHORITY_REJECTED"
  )
}
