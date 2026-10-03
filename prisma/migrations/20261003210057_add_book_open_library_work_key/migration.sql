-- AlterTable
ALTER TABLE "books" ADD COLUMN "open_library_work_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "books_open_library_work_key_key" ON "books"("open_library_work_key");
