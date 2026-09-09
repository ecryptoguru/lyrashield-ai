-- Old application images omit principalId. Fill only a real connection-backed
-- principal; never turn a connectionless request into an OAuth identity.
CREATE FUNCTION app.bind_agent_operation_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."connectionId" IS NOT NULL THEN
    IF NEW."principalId" IS NULL THEN
      NEW."principalId" := NEW."connectionId";
      NEW."principalType" := 'OAUTH_CONNECTION';
    END IF;
    IF NEW."principalType" <> 'OAUTH_CONNECTION'
       OR NEW."principalId" <> NEW."connectionId" THEN
      RAISE EXCEPTION 'Invalid OAuth operation principal' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."principalType" = 'OAUTH_CONNECTION' THEN
    RAISE EXCEPTION 'OAuth operation requires a connection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_operation_principal_compat
BEFORE INSERT OR UPDATE ON "agent_operations"
FOR EACH ROW EXECUTE FUNCTION app.bind_agent_operation_principal();
