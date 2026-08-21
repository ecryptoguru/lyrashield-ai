-- Platform-operator identity on User: global authority that never derives
-- from workspace membership or tenant roles. Only value is "PLATFORM_OPERATOR".
ALTER TABLE "users" ADD COLUMN "platformRole" TEXT;
