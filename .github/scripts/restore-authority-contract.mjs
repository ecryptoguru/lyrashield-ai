import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export const DISPATCH_MIGRATION = "20261105130000_durable_dispatch_authority"
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
const mirrorSql = readFileSync(
  new URL("../../packages/runtime-control/sql/authority-mirror.sql", import.meta.url),
  "utf8"
)
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
  [...dispatchSql.matchAll(/CREATE FUNCTION app\.([a-z_]+)\([^]*?AS \$\$([^]*?)\$\$;/g)].map(
    (match) => [match[1], match[2]]
  )
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
  { name: "scan_dispatch_scope_digest", arguments: "text", names: ["scan_id"] },
]
const triggers = [
  ...dispatchSql.matchAll(
    /CREATE TRIGGER ([a-z_]+)\s+BEFORE (INSERT|UPDATE|DELETE)(?: OR (INSERT|UPDATE|DELETE))? ON "([A-Za-z]+)"\s+FOR EACH ROW EXECUTE FUNCTION app\.([a-z_]+)\(\);/g
  ),
].map((match) => ({
  name: match[1],
  table: match[4],
  function: match[5],
  type:
    3 |
    { INSERT: 4, DELETE: 8, UPDATE: 16 }[match[2]] |
    (match[3] ? { INSERT: 4, DELETE: 8, UPDATE: 16 }[match[3]] : 0),
}))
requireCheck(
  dispatchTables.length === 11 &&
    triggers.length === 25 &&
    triggers.every((trigger) => bodies.has(trigger.function)) &&
    dispatchHelpers.every((helper) => bodies.has(helper.name)),
  "SOURCE_CONTRACT_UNAVAILABLE"
)
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
  } = definition
  return `n.nspname=${literal(schema)} AND p.proname=${literal(name)}
    AND pg_catalog.oidvectortypes(p.proargtypes)=${literal(args)}
    AND p.proargnames ${names ? `=${tableArray(names)}` : "IS NULL"}
    AND p.prorettype=${literal(result)}::regtype AND NOT p.proretset AND p.prokind='f'
    AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.provariadic=0
    AND p.protrftypes IS NULL AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL
    AND p.provolatile=${literal(volatility)} AND p.proisstrict=${strict}
    AND NOT p.proleakproof AND p.proparallel='u' AND p.procost=100 AND p.prorows=0
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
    WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND ${reachablePrivilege(role, "function", "p.oid", "EXECUTE")}
      AND (${approved}) IS NOT TRUE)`
}
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
      AND t.tgtype=${trigger.type} AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
      AND ${functionContract("app", { name: trigger.function, body: bodies.get(trigger.function), result: "trigger" })})`
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
  const roleChecks = deniedRoles
    .map(
      (role) => `${restrictedRole(role)} AND NOT EXISTS (
    SELECT 1 FROM unnest(${tableArray(dispatchTables)}) name WHERE
      ${reachablePrivilege(role, "table", "format('public.%I',name)", allPrivileges)})`
    )
    .join(" AND ")
  return `SELECT json_build_object(
    'migration', (SELECT count(*)=1 AND bool_and(checksum=${literal(sha256(dispatchSql))}
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
      FROM public."_prisma_migrations" WHERE migration_name=${literal(DISPATCH_MIGRATION)}),
    'tables', (SELECT count(*)=11 AND bool_and(c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY(${tableArray(dispatchTables)})),
    'triggers', ${triggerChecks},
    'helpers', ${helpers},
    'privilegedFunctions', ${deniedRoles.map((role) => reviewedDefinersOnly(role)).join(" AND ")},
    'closed', NOT EXISTS (SELECT 1 FROM public."ScanAuthorityEpoch" WHERE "isOpen" OR "openKey" IS NOT NULL OR "closedAt" IS NULL)
      AND EXISTS (SELECT 1 FROM public."ScanAuthorityEpoch" WHERE id='scan-authority-baseline' AND epoch=1
        AND NOT "isOpen" AND "openKey" IS NULL AND "openedAt" IS NULL AND "closedAt" IS NOT NULL),
    'roles', ${roleChecks})::text;`
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
