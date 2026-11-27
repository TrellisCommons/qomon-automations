-- The job runs every contact rule, not only the household match.
UPDATE "job_run" SET "job" = 'contact-rules' WHERE "job" = 'household-match';

-- CreateEnum
CREATE TYPE "DeceasedHandling" AS ENUM ('WRITTEN', 'FOUND');

-- AlterTable
ALTER TABLE "space" ADD COLUMN     "deceasedField" TEXT,
ADD COLUMN     "deceasedValue" TEXT NOT NULL DEFAULT 'yes';

-- CreateTable
CREATE TABLE "handled_deceased" (
    "spaceKey" TEXT NOT NULL,
    "contactId" INTEGER NOT NULL,
    "handling" "DeceasedHandling" NOT NULL,
    "runId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handled_deceased_pkey" PRIMARY KEY ("spaceKey","contactId")
);

-- AddForeignKey
ALTER TABLE "handled_deceased" ADD CONSTRAINT "handled_deceased_spaceKey_fkey" FOREIGN KEY ("spaceKey") REFERENCES "space"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
