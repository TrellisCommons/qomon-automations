-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunKind" ADD VALUE 'INCREMENTAL';
ALTER TYPE "RunKind" ADD VALUE 'SWEEP';

-- CreateTable
CREATE TABLE "contact_mirror" (
    "spaceKey" TEXT NOT NULL,
    "contactId" INTEGER NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "inScope" BOOLEAN NOT NULL,
    "householdHash" TEXT NOT NULL,
    "presenceRefId" INTEGER,
    "presenceValue" TEXT,
    "presenceDate" TEXT,
    "markerRefId" INTEGER,

    CONSTRAINT "contact_mirror_pkey" PRIMARY KEY ("spaceKey","contactId")
);

-- CreateTable
CREATE TABLE "dirty_household" (
    "spaceKey" TEXT NOT NULL,
    "householdHash" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "quarantinedAt" TIMESTAMP(3),

    CONSTRAINT "dirty_household_pkey" PRIMARY KEY ("spaceKey","householdHash")
);

-- CreateTable
CREATE TABLE "sync_cursor" (
    "spaceKey" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "cursor" TEXT,
    "ingestedAt" TIMESTAMP(3),
    "sweptAt" TIMESTAMP(3),
    "keyId" TEXT,

    CONSTRAINT "sync_cursor_pkey" PRIMARY KEY ("spaceKey","job")
);

-- CreateTable
CREATE TABLE "alert_state" (
    "spaceKey" TEXT NOT NULL,
    "alertKey" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_state_pkey" PRIMARY KEY ("spaceKey","alertKey")
);

-- CreateIndex
CREATE INDEX "contact_mirror_spaceKey_householdHash_idx" ON "contact_mirror"("spaceKey", "householdHash");

-- CreateIndex
CREATE INDEX "dirty_household_spaceKey_quarantinedAt_nextAttemptAt_idx" ON "dirty_household"("spaceKey", "quarantinedAt", "nextAttemptAt");

