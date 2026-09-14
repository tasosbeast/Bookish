-- AlterTable
ALTER TABLE "activities" ADD COLUMN "historical" BOOLEAN NOT NULL DEFAULT false;

-- Ensure UTC date conversion for backfilled finished_reading activities
UPDATE "activities"
SET "finished_on" = DATE("created_at" AT TIME ZONE 'UTC')
WHERE "type" = 'finished_reading' AND ("finished_on" IS NULL OR "finished_on" = DATE("created_at"));
