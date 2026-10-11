-- AlterTable
ALTER TABLE "space" ALTER COLUMN "householdValue" SET DEFAULT 'absent',
ADD COLUMN     "markerField" TEXT NOT NULL DEFAULT 'Presence source',
ADD COLUMN     "markerValue" TEXT NOT NULL DEFAULT 'household_match';

-- AlterTable
ALTER TABLE "planned_write" ADD COLUMN     "writtenPresenceDate" TEXT;
