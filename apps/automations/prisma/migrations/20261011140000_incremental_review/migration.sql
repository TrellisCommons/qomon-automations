-- AlterTable
ALTER TABLE "dirty_household" ADD COLUMN     "dryRunAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "planned_write_status_updatedAt_idx" ON "planned_write"("status", "updatedAt");
