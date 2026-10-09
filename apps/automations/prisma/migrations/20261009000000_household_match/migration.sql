-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('HOURLY', 'BACKFILL');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'TRIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "WriteStatus" AS ENUM ('PLANNED', 'SKIPPED', 'APPLYING', 'APPLIED', 'VERIFIED', 'FAILED');

-- CreateTable
CREATE TABLE "space" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qomonApiKeyEncrypted" TEXT NOT NULL,
    "qomonApiBase" TEXT,
    "writesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "activeUntil" TIMESTAMP(3),
    "municipality" TEXT,
    "canvassedValues" TEXT[],
    "householdValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "spaceKey" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "applying" BOOLEAN NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "stats" JSONB,
    "error" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_write" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "contactId" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "valueBefore" TEXT,
    "valueAfter" TEXT NOT NULL,
    "triggerContactId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "WriteStatus" NOT NULL DEFAULT 'PLANNED',
    "detail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planned_write_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_log_entry" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" TEXT NOT NULL,

    CONSTRAINT "change_log_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_run_spaceKey_startedAt_idx" ON "job_run"("spaceKey", "startedAt");

-- CreateIndex
CREATE INDEX "planned_write_runId_status_idx" ON "planned_write"("runId", "status");

-- CreateIndex
CREATE INDEX "planned_write_contactId_idx" ON "planned_write"("contactId");

-- CreateIndex
CREATE INDEX "change_log_entry_subjectType_subjectId_idx" ON "change_log_entry"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "change_log_entry_correlationId_idx" ON "change_log_entry"("correlationId");

-- CreateIndex
CREATE INDEX "change_log_entry_at_idx" ON "change_log_entry"("at");

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_spaceKey_fkey" FOREIGN KEY ("spaceKey") REFERENCES "space"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_write" ADD CONSTRAINT "planned_write_runId_fkey" FOREIGN KEY ("runId") REFERENCES "job_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The change log is the audit trail of what the automation changed in a
-- campaign's data: append-only.
CREATE FUNCTION change_log_entry_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'change_log_entry is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER change_log_entry_append_only
  BEFORE UPDATE OR DELETE ON "change_log_entry"
  FOR EACH ROW EXECUTE FUNCTION change_log_entry_append_only();
