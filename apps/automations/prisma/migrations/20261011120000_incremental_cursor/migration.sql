-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'INCREMENTAL';

-- AlterTable
ALTER TABLE "space" ADD COLUMN     "changedCursor" TIMESTAMP(3);
