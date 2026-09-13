-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('started_reading', 'finished_reading', 'rated_book', 'reviewed_book');

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "review_id" UUID,
    "type" "ActivityType" NOT NULL,
    "rating" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "activities_review_id_key" ON "activities"("review_id");

-- CreateIndex
CREATE INDEX "activities_user_id_created_at_id_idx" ON "activities"("user_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "activities_created_at_id_idx" ON "activities"("created_at" DESC, "id");

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
