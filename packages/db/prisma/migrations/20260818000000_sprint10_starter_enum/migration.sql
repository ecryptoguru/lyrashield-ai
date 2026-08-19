-- Sprint 10: Add STARTER tier to WorkspacePlan enum.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in PostgreSQL < 12
-- and Prisma wraps each migration in a transaction. Prisma automatically detects
-- this statement and runs it outside a transaction. The new value is added after
-- all existing values so existing rows are unaffected.
ALTER TYPE "WorkspacePlan" ADD VALUE IF NOT EXISTS 'STARTER';
