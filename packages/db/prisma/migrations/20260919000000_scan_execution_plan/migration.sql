-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "executionPlan" JSONB,
ADD COLUMN     "executionPlanHash" TEXT;

