ALTER TABLE "myra_messages"
  ADD COLUMN "helpful" BOOLEAN,
  ADD COLUMN "ratedAt" TIMESTAMP(3);

ALTER TABLE "myra_messages"
  ADD CONSTRAINT "myra_messages_feedback_assistant_only"
  CHECK (
    ("helpful" IS NULL AND "ratedAt" IS NULL)
    OR ("helpful" IS NOT NULL AND "ratedAt" IS NOT NULL AND "role"::text = 'ASSISTANT')
  );
