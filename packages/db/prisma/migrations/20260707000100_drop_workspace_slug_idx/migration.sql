-- Reconcile schema drift: Workspace.slug is already covered by the unique
-- index "Workspace_slug_key"; the plain index was removed from schema.prisma.
DROP INDEX IF EXISTS "Workspace_slug_idx";
