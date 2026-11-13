import type { AuthoritySqlConnection } from "./postgres-mirror"

/** Read-only prerequisite for the separately provisioned protected stream pin controller.
 * Grants nothing and authorizes no CAS by itself. The caller must retain its
 * native session gate and exact preinstalled epoch/stream row locks through CAS.
 */
export async function assertScanJournalSealRolePrerequisites(
  connection: AuthoritySqlConnection,
  expectedRole: string
): Promise<void> {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(expectedRole) ||
    [
      "postgres",
      "public",
      "anon",
      "authenticated",
      "service_role",
      "app_runtime_prod",
      "app_system_prod",
      "app_runtime_ci",
    ].includes(expectedRole)
  )
    throw new Error("A distinct restricted journal seal control login is required")
  const result = await connection.query(
    `SELECT session_user=$1 AND current_user=$1 AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
      AND has_schema_privilege(current_user,'public','USAGE')
      AND has_schema_privilege(current_user,'app','USAGE')
      AND has_table_privilege(current_user,'public."ScanAuthorityEpoch"','SELECT')
      AND has_table_privilege(current_user,'public."ScanSupervisorJournalStream"','SELECT')
      AND has_column_privilege(current_user,'public."ScanAuthorityEpoch"','updatedAt','UPDATE')
      AND has_column_privilege(current_user,'public."ScanSupervisorJournalStream"','updatedAt','UPDATE')
      AND NOT EXISTS(SELECT 1 FROM pg_roles reachable WHERE pg_has_role(current_user,reachable.oid,'SET')
        AND (reachable.rolsuper OR reachable.rolbypassrls OR reachable.rolcreaterole OR reachable.rolcreatedb
          OR reachable.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data','pg_checkpoint','pg_maintain')
          OR has_database_privilege(reachable.oid,current_database(),'CREATE')
          OR has_database_privilege(reachable.oid,current_database(),'TEMPORARY')
          OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND has_schema_privilege(reachable.oid,n.oid,'CREATE'))
          OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
              AND has_table_privilege(reachable.oid,c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER,MAINTAIN'))
          OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
              AND NOT(c.relname IN ('ScanAuthorityEpoch','ScanSupervisorJournalStream') AND a.attname='updatedAt')
              AND has_column_privilege(reachable.oid,c.oid,a.attnum,'UPDATE'))
          OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.prosecdef AND has_function_privilege(reachable.oid,p.oid,'EXECUTE')))) AS safe
      FROM pg_roles r WHERE r.rolname=current_user`,
    [expectedRole]
  )
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Restricted journal seal control role is not provisioned")
}
