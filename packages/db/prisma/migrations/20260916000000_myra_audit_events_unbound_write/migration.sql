-- v18 1.1: account deletion must be able to scrub myra_audit_events rows
-- (accountId -> NULL plus a metadata key strip) and the 90-day retention
-- sweep must be able to delete them. The table already grants the unbound
-- trusted path INSERT and SELECT; this adds UPDATE and DELETE on the same
-- condition so the scrub and the prune can run through it.
-- Additive only: the audit trail stays append-only for every bound context —
-- no account-owner or public-session write policy is created.

CREATE POLICY myra_audit_events_unbound_update ON "myra_audit_events"
  FOR UPDATE USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL)
  WITH CHECK (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);

CREATE POLICY myra_audit_events_unbound_delete ON "myra_audit_events"
  FOR DELETE USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
