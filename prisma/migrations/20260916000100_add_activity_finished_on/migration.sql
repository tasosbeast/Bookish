-- AlterTable
ALTER TABLE "activities" ADD COLUMN "finished_on" DATE;

-- Backfill existing finished_reading activities
UPDATE "activities"
SET "finished_on" = DATE("created_at")
WHERE "type" = 'finished_reading';
