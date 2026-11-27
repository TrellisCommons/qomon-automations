-- AlterEnum
ALTER TYPE "DeceasedHandling" ADD VALUE 'SENT';
ALTER TYPE "DeceasedHandling" ADD VALUE 'REVIEW';

-- AlterTable
ALTER TABLE "handled_deceased" ADD COLUMN "reviewNotifiedAt" TIMESTAMP(3);
