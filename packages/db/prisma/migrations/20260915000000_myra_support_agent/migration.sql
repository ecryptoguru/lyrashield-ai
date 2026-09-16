-- Myra support agent (docs/myra-spec.md sections 5, 8, 9): support
-- conversations, support cases, confirmed operations, demo bookings,
-- knowledge base, per-account memory, identity verification, and sanitized
-- audit — additive tables only.
--
-- Ownership is dual-channel: `accountId` (User.id) for authenticated actors
-- and `publicSessionId` for anonymous marketing visitors — never a synthetic
-- workspace. `workspaceId`, where present, is nullable dashboard context
-- only. Postgres RLS enforces three policy shapes:
--   * unbound trusted path — app.current_account_id() AND
--     app.myra_public_session_id() both NULL — for internal service and
--     operator work (inbox, reconciliation, knowledge ingestion);
--   * account owner — "accountId" = app.current_account_id();
--   * public owner — "publicSessionId" = app.myra_public_session_id()
--     (myra_public_sessions matches on its own "id").
-- Child tables (myra_messages, myra_flow_sessions, support_case_replies)
-- delegate ownership to the parent row through EXISTS subqueries.
-- myra_memories adds a RESTRICTIVE owner boundary so unbound reads see
-- nothing; myra_audit_events is append-only (insert under any context,
-- select only when unbound); knowledge tables allow reads under any bound
-- context — the service layer filters audience/roles — while ingestion
-- stays an unbound internal path.
--
-- demo_bookings carries a GiST exclusion constraint over the buffered hold
-- interval so overlapping HELD/CONFIRMED/OUTCOME_UNKNOWN reservations can
-- never coexist — the durable overlap protection the booking spec requires.
--
-- Additive and forward-only: new enums, new tables, new indexes, one
-- extension, one generated search column, one helper function, and new RLS
-- policies. No existing table, policy, or function is altered.

-- CreateEnum
CREATE TYPE "MyraSurface" AS ENUM ('MARKETING', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "MyraMessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL_EVENT');

-- CreateEnum
CREATE TYPE "MyraConversationState" AS ENUM ('ACTIVE', 'ENDED', 'TAKEOVER');

-- CreateEnum
CREATE TYPE "MyraOperationStatus" AS ENUM ('DRAFT', 'AWAITING_CONFIRMATION', 'EXECUTING', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MyraFlowStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ESCALATED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('NEW', 'OPEN', 'PENDING_USER', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportCaseAuthorType" AS ENUM ('USER', 'OPERATOR', 'MYRA');

-- CreateEnum
CREATE TYPE "DemoBookingStatus" AS ENUM ('HELD', 'CONFIRMED', 'CANCELED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "MyraKnowledgeAudience" AS ENUM ('PUBLIC', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "MyraKnowledgeStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "myra_public_sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "surface" "MyraSurface" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "myra_public_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_conversations" (
    "id" TEXT NOT NULL,
    "surface" "MyraSurface" NOT NULL,
    "state" "MyraConversationState" NOT NULL DEFAULT 'ACTIVE',
    "accountId" TEXT,
    "publicSessionId" TEXT,
    "workspaceId" TEXT,
    "routeContext" TEXT,
    "humanTakeoverAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "myra_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MyraMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "component" JSONB,
    "taskRecord" JSONB,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "myra_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_flow_sessions" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "status" "MyraFlowStatus" NOT NULL DEFAULT 'ACTIVE',
    "state" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "myra_flow_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_cases" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'NEW',
    "subject" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "accountId" TEXT,
    "publicSessionId" TEXT,
    "workspaceId" TEXT,
    "replyEmail" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "conversationId" TEXT,
    "assigneeUserId" TEXT,
    "takenOverAt" TIMESTAMP(3),
    "lastUserReplyAt" TIMESTAMP(3),
    "lastOperatorReplyAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "notificationState" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_case_replies" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorType" "SupportCaseAuthorType" NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_operations" (
    "id" TEXT NOT NULL,
    "operationName" TEXT NOT NULL,
    "status" "MyraOperationStatus" NOT NULL DEFAULT 'DRAFT',
    "accountId" TEXT,
    "publicSessionId" TEXT,
    "workspaceId" TEXT,
    "conversationId" TEXT,
    "inputHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "myra_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_bookings" (
    "id" TEXT NOT NULL,
    "status" "DemoBookingStatus" NOT NULL DEFAULT 'HELD',
    "attendeeEmail" TEXT NOT NULL,
    "attendeeName" TEXT NOT NULL,
    "attendeeContext" TEXT,
    "attendeeVerifiedAt" TIMESTAMP(3),
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "holdStartsAt" TIMESTAMP(3) NOT NULL,
    "holdEndsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "organizerEmail" TEXT NOT NULL,
    "providerEventId" TEXT,
    "meetLink" TEXT,
    "conferenceState" TEXT NOT NULL DEFAULT 'none',
    "manageTokenHash" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "accountId" TEXT,
    "publicSessionId" TEXT,
    "conversationId" TEXT,
    "rescheduledFromId" TEXT,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_knowledge_releases" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "myra_knowledge_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_knowledge_entries" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "audience" "MyraKnowledgeAudience" NOT NULL DEFAULT 'PUBLIC',
    "allowedRoles" TEXT[],
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceRef" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "reviewAfter" TIMESTAMP(3),
    "capabilityStatus" TEXT NOT NULL DEFAULT 'available',
    "status" "MyraKnowledgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "myra_knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_memories" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "myra_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_identity_verifications" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "publicSessionId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "myra_identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "myra_audit_events" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "accountId" TEXT,
    "publicSessionId" TEXT,
    "operatorId" TEXT,
    "workspaceId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "myra_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "myra_public_sessions_tokenHash_key" ON "myra_public_sessions"("tokenHash");
CREATE INDEX "myra_public_sessions_expiresAt_idx" ON "myra_public_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "myra_conversations_accountId_updatedAt_idx" ON "myra_conversations"("accountId", "updatedAt");
CREATE INDEX "myra_conversations_publicSessionId_updatedAt_idx" ON "myra_conversations"("publicSessionId", "updatedAt");
CREATE INDEX "myra_conversations_workspaceId_idx" ON "myra_conversations"("workspaceId");
CREATE INDEX "myra_conversations_expiresAt_idx" ON "myra_conversations"("expiresAt");

-- CreateIndex
CREATE INDEX "myra_messages_conversationId_createdAt_id_idx" ON "myra_messages"("conversationId", "createdAt", "id");
CREATE INDEX "myra_messages_traceId_idx" ON "myra_messages"("traceId");

-- CreateIndex
CREATE INDEX "myra_flow_sessions_conversationId_status_idx" ON "myra_flow_sessions"("conversationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "support_cases_reference_key" ON "support_cases"("reference");
CREATE INDEX "support_cases_status_createdAt_idx" ON "support_cases"("status", "createdAt");
CREATE INDEX "support_cases_accountId_idx" ON "support_cases"("accountId");
CREATE INDEX "support_cases_publicSessionId_idx" ON "support_cases"("publicSessionId");
CREATE INDEX "support_cases_workspaceId_idx" ON "support_cases"("workspaceId");
CREATE INDEX "support_cases_assigneeUserId_status_idx" ON "support_cases"("assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "support_case_replies_caseId_createdAt_id_idx" ON "support_case_replies"("caseId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "myra_operations_operationName_idempotencyKey_key" ON "myra_operations"("operationName", "idempotencyKey");
CREATE INDEX "myra_operations_accountId_idx" ON "myra_operations"("accountId");
CREATE INDEX "myra_operations_publicSessionId_idx" ON "myra_operations"("publicSessionId");
CREATE INDEX "myra_operations_status_expiresAt_idx" ON "myra_operations"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "demo_bookings_providerEventId_key" ON "demo_bookings"("providerEventId");
CREATE UNIQUE INDEX "demo_bookings_manageTokenHash_key" ON "demo_bookings"("manageTokenHash");
CREATE UNIQUE INDEX "demo_bookings_idempotencyKey_key" ON "demo_bookings"("idempotencyKey");
CREATE INDEX "demo_bookings_holdStartsAt_holdEndsAt_idx" ON "demo_bookings"("holdStartsAt", "holdEndsAt");
CREATE INDEX "demo_bookings_status_idx" ON "demo_bookings"("status");
CREATE INDEX "demo_bookings_attendeeEmail_idx" ON "demo_bookings"("attendeeEmail");

-- CreateIndex
CREATE UNIQUE INDEX "myra_knowledge_releases_version_key" ON "myra_knowledge_releases"("version");

-- CreateIndex
CREATE INDEX "myra_knowledge_entries_audience_status_topic_idx" ON "myra_knowledge_entries"("audience", "status", "topic");
CREATE INDEX "myra_knowledge_entries_releaseId_idx" ON "myra_knowledge_entries"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "myra_memories_accountId_key_key" ON "myra_memories"("accountId", "key");

-- CreateIndex
CREATE INDEX "myra_identity_verifications_email_purpose_expiresAt_idx" ON "myra_identity_verifications"("email", "purpose", "expiresAt");
CREATE INDEX "myra_identity_verifications_expiresAt_idx" ON "myra_identity_verifications"("expiresAt");

-- CreateIndex
CREATE INDEX "myra_audit_events_action_createdAt_idx" ON "myra_audit_events"("action", "createdAt");
CREATE INDEX "myra_audit_events_accountId_idx" ON "myra_audit_events"("accountId");
CREATE INDEX "myra_audit_events_operatorId_createdAt_idx" ON "myra_audit_events"("operatorId", "createdAt");
CREATE INDEX "myra_audit_events_createdAt_idx" ON "myra_audit_events"("createdAt");

-- AddForeignKey
ALTER TABLE "myra_messages" ADD CONSTRAINT "myra_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "myra_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "myra_flow_sessions" ADD CONSTRAINT "myra_flow_sessions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "myra_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_case_replies" ADD CONSTRAINT "support_case_replies_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "myra_knowledge_entries" ADD CONSTRAINT "myra_knowledge_entries_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "myra_knowledge_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Overlap protection for demo holds: a buffered hold interval may not
-- overlap any other live reservation. The hold columns are TIMESTAMP(3)
-- (Prisma DateTime — always written UTC), so they are pinned to UTC before
-- building tstzrange values: the bare timestamp→timestamptz cast is STABLE
-- (session TimeZone dependent) and illegal in an index expression.
-- Range exclusion needs no scalar operator class today, but btree_gist is
-- required if a scalar dimension (e.g. organizer) is added later — create
-- it once here.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "demo_bookings" ADD CONSTRAINT "demo_bookings_no_overlapping_holds"
  EXCLUDE USING gist (
    tstzrange("holdStartsAt" AT TIME ZONE 'UTC', "holdEndsAt" AT TIME ZONE 'UTC') WITH &&
  )
  WHERE ("status" IN ('HELD', 'CONFIRMED', 'OUTCOME_UNKNOWN'));

-- Knowledge-base full-text search vector, maintained by Postgres. The Prisma
-- model declares it Unsupported so the client never attempts to write it.
ALTER TABLE "myra_knowledge_entries" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("topic", '') || ' ' || coalesce("content", ''))
  ) STORED;

CREATE INDEX "myra_knowledge_entries_searchVector_idx" ON "myra_knowledge_entries" USING gin("searchVector");

-- Public-session RLS context, mirroring app.current_account_id(). Returns
-- NULL when unset or empty.
CREATE OR REPLACE FUNCTION app.myra_public_session_id() RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT NULLIF(current_setting('app.myra_public_session_id', true), '')
$$;

-- RLS backstop. FORCE so even the table owner is subject to the policies.
ALTER TABLE "myra_public_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_public_sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_conversations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_flow_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_flow_sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "support_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_cases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "support_case_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_case_replies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "demo_bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "demo_bookings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_knowledge_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_knowledge_releases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_knowledge_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_knowledge_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_memories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_memories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_identity_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_identity_verifications" FORCE ROW LEVEL SECURITY;
ALTER TABLE "myra_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "myra_audit_events" FORCE ROW LEVEL SECURITY;

-- Dual-owner tables: unbound trusted path OR account owner OR public owner.

-- myra_public_sessions: the session row itself is addressed by its id.
CREATE POLICY myra_public_sessions_unbound ON "myra_public_sessions"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_public_sessions_public ON "myra_public_sessions"
  FOR ALL USING ("id" = app.myra_public_session_id())
  WITH CHECK ("id" = app.myra_public_session_id());

CREATE POLICY myra_conversations_unbound ON "myra_conversations"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_conversations_account ON "myra_conversations"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
CREATE POLICY myra_conversations_public ON "myra_conversations"
  FOR ALL USING ("publicSessionId" = app.myra_public_session_id())
  WITH CHECK ("publicSessionId" = app.myra_public_session_id());

CREATE POLICY myra_operations_unbound ON "myra_operations"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_operations_account ON "myra_operations"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
CREATE POLICY myra_operations_public ON "myra_operations"
  FOR ALL USING ("publicSessionId" = app.myra_public_session_id())
  WITH CHECK ("publicSessionId" = app.myra_public_session_id());

CREATE POLICY support_cases_unbound ON "support_cases"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY support_cases_account ON "support_cases"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
CREATE POLICY support_cases_public ON "support_cases"
  FOR ALL USING ("publicSessionId" = app.myra_public_session_id())
  WITH CHECK ("publicSessionId" = app.myra_public_session_id());

CREATE POLICY demo_bookings_unbound ON "demo_bookings"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY demo_bookings_account ON "demo_bookings"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
CREATE POLICY demo_bookings_public ON "demo_bookings"
  FOR ALL USING ("publicSessionId" = app.myra_public_session_id())
  WITH CHECK ("publicSessionId" = app.myra_public_session_id());

-- Child tables: ownership resolves through the parent's owner columns.

-- myra_messages is scoped through myra_conversations.
CREATE POLICY myra_messages_unbound ON "myra_messages"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_messages_account ON "myra_messages"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."accountId" = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."accountId" = app.current_account_id()
    )
  );
CREATE POLICY myra_messages_public ON "myra_messages"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."publicSessionId" = app.myra_public_session_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."publicSessionId" = app.myra_public_session_id()
    )
  );

-- myra_flow_sessions is scoped through myra_conversations.
CREATE POLICY myra_flow_sessions_unbound ON "myra_flow_sessions"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_flow_sessions_account ON "myra_flow_sessions"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."accountId" = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."accountId" = app.current_account_id()
    )
  );
CREATE POLICY myra_flow_sessions_public ON "myra_flow_sessions"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."publicSessionId" = app.myra_public_session_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "myra_conversations" c
      WHERE c."id" = "conversationId" AND c."publicSessionId" = app.myra_public_session_id()
    )
  );

-- support_case_replies is scoped through support_cases.
CREATE POLICY support_case_replies_unbound ON "support_case_replies"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY support_case_replies_account ON "support_case_replies"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "support_cases" sc
      WHERE sc."id" = "caseId" AND sc."accountId" = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "support_cases" sc
      WHERE sc."id" = "caseId" AND sc."accountId" = app.current_account_id()
    )
  );
CREATE POLICY support_case_replies_public ON "support_case_replies"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "support_cases" sc
      WHERE sc."id" = "caseId" AND sc."publicSessionId" = app.myra_public_session_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "support_cases" sc
      WHERE sc."id" = "caseId" AND sc."publicSessionId" = app.myra_public_session_id()
    )
  );

-- myra_memories is account-only. The RESTRICTIVE boundary keeps unbound and
-- foreign-account contexts from ever seeing a row (mirrors
-- account_acquisitions); the permissive unbound policy can never widen past
-- that boundary — it exists so the trusted-path shape stays uniform.
CREATE POLICY myra_memories_unbound ON "myra_memories"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_memories_account ON "myra_memories"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
CREATE POLICY myra_memories_owner_boundary ON "myra_memories" AS RESTRICTIVE
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());

-- myra_identity_verifications are service-bound: the issuing/verifying code
-- runs unbound, and a bound public session may only see its own rows.
CREATE POLICY myra_identity_verifications_unbound ON "myra_identity_verifications"
  FOR ALL USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_identity_verifications_public ON "myra_identity_verifications"
  FOR ALL USING ("publicSessionId" = app.myra_public_session_id())
  WITH CHECK ("publicSessionId" = app.myra_public_session_id());

-- Knowledge base: reads are allowed under any bound context (the service
-- layer filters audience/roles); ingestion is an unbound internal path.
CREATE POLICY myra_knowledge_releases_read ON "myra_knowledge_releases"
  FOR SELECT USING (true);
CREATE POLICY myra_knowledge_releases_insert ON "myra_knowledge_releases"
  FOR INSERT WITH CHECK (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_knowledge_releases_update ON "myra_knowledge_releases"
  FOR UPDATE USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL)
  WITH CHECK (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_knowledge_releases_delete ON "myra_knowledge_releases"
  FOR DELETE USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);

CREATE POLICY myra_knowledge_entries_read ON "myra_knowledge_entries"
  FOR SELECT USING (true);
CREATE POLICY myra_knowledge_entries_insert ON "myra_knowledge_entries"
  FOR INSERT WITH CHECK (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_knowledge_entries_update ON "myra_knowledge_entries"
  FOR UPDATE USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL)
  WITH CHECK (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
CREATE POLICY myra_knowledge_entries_delete ON "myra_knowledge_entries"
  FOR DELETE USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);

-- Audit is append-only: any context may record an event; only unbound
-- operator/system contexts may read. No UPDATE/DELETE policies exist.
CREATE POLICY myra_audit_events_insert ON "myra_audit_events"
  FOR INSERT WITH CHECK (true);
CREATE POLICY myra_audit_events_unbound_read ON "myra_audit_events"
  FOR SELECT USING (app.current_account_id() IS NULL AND app.myra_public_session_id() IS NULL);
