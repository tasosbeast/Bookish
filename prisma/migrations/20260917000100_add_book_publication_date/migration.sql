-- AlterTable
ALTER TABLE "books" ADD COLUMN "publication_date" DATE;

-- CreateIndex
CREATE INDEX "books_publication_date_id_idx" ON "books"("publication_date", "id");
