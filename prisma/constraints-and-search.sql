-- Append to the initial Prisma-generated migration AFTER CREATE TABLE statements.
ALTER TABLE reviews ADD CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE reviews ADD CONSTRAINT reviews_likes_count_check CHECK (likes_count >= 0);
ALTER TABLE user_books ADD CONSTRAINT user_books_rating_check
  CHECK (user_rating IS NULL OR user_rating BETWEEN 1 AND 5);
ALTER TABLE books ADD CONSTRAINT books_rating_cache_check CHECK (
  (ratings_count = 0 AND average_rating IS NULL) OR
  (ratings_count > 0 AND average_rating IS NOT NULL AND average_rating BETWEEN 1 AND 5)
);
ALTER TABLE books ADD CONSTRAINT books_isbn_format_check
  CHECK (isbn IS NULL OR isbn ~ '^[0-9]{13}$');
ALTER TABLE books ADD CONSTRAINT books_publication_year_check
  CHECK (publication_year IS NULL OR publication_year BETWEEN 1 AND 9999);

-- Case-insensitive identity uniqueness, in addition to Prisma's unique indexes.
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX genres_name_lower_key ON genres (lower(name));

-- Supports ILIKE substring matching and trigram similarity search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX books_title_trgm_idx ON books USING gin (title gin_trgm_ops);
CREATE INDEX books_author_trgm_idx ON books USING gin (author gin_trgm_ops);
