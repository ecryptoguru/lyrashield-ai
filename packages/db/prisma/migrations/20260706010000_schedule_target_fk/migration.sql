-- AddForeignKey: Schedule → Target
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
