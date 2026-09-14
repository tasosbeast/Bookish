CREATE TABLE "release_metadata_sources" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_isbn" VARCHAR(13) NOT NULL,
    "verified_publication_date" DATE NOT NULL,
    "last_verified_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "release_metadata_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "release_metadata_sources_book_id_key" ON "release_metadata_sources"("book_id");
CREATE UNIQUE INDEX "release_metadata_sources_provider_source_isbn_key" ON "release_metadata_sources"("provider", "source_isbn");
CREATE INDEX "release_metadata_sources_last_verified_at_idx" ON "release_metadata_sources"("last_verified_at");

ALTER TABLE "release_metadata_sources"
  ADD CONSTRAINT "release_metadata_sources_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
