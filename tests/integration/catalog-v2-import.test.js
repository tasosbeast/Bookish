import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  sourceFingerprint,
} from '../../scripts/catalog/contracts.js';
import { importResolvedCatalog } from '../../scripts/catalog/import.js';

function isbnAt(index) {
  const stem = `979${String(index).padStart(9, '0')}`;
  const sum = [...stem].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${stem}${(10 - sum % 10) % 10}`;
}

function resolvedEntry(source, isbn, metadata = {}) {
  return {
    key: source.key,
    sourceFingerprint: sourceFingerprint(source),
    resolverVersion: CATALOG_RESOLVER_VERSION,
    status: 'resolved',
    metadata: {
      title: source.title, author: source.author, isbn, publicationYear: 2020, description: 'Catalog description',
      coverImageUrl: 'https://books.google.com/books/content?id=fixture', genres: [{ name: 'History', slug: 'history' }], ...metadata,
    },
    providerIds: { openLibraryWork: null, openLibraryEdition: null, googleBooksVolume: 'fixture' },
    provenance: { title: 'curated_source', author: 'curated_source', publicationYear: 'google_books', description: 'google_books', coverImageUrl: 'google_books', genres: 'google_books' },
    selection: { score: 80, reasons: ['fixture'] },
    diagnostic: null,
  };
}

function unresolvedEntry(source, status) {
  return {
    key: source.key, sourceFingerprint: sourceFingerprint(source), resolverVersion: CATALOG_RESOLVER_VERSION, status,
    diagnostic: { provider: null, stage: 'resolution', code: 'fixture', message: 'Fixture', retryable: false, attempts: 0 },
  };
}

test('PostgreSQL: artifact import preserves Book identity and all user-generated relations', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const seed = Number.parseInt(tag, 16) % 1000000;
  const existingSource = { key: `existing-book-${tag}`, title: 'Updated Existing Book', author: 'Updated Author' };
  const newSource = { key: `new-book-${tag}`, title: 'New Catalog Book', author: 'Catalog Author' };
  const reviewSource = { key: `review-book-${tag}`, title: 'Needs Review', author: 'Review Author' };
  const failedSource = { key: `failed-book-${tag}`, title: 'Failed Book', author: 'Failed Author' };
  const isbns = [isbnAt(seed), isbnAt(seed + 1000000), isbnAt(seed + 2000000), isbnAt(seed + 3000000)];
  assert.equal(await prisma.book.count({ where: { isbn: { in: isbns } } }), 0, 'Test requires disposable ISBNs; existing rows are never removed');

  const priorGenreIds = new Set((await prisma.genre.findMany()).map(genre => genre.id));
  const user = await prisma.user.create({ data: { username: `catalog_${tag}`, email: `catalog_${tag}@example.com`, passwordHash: 'integration-test-only' } });
  const fiction = await prisma.genre.upsert({ where: { slug: 'fiction' }, create: { name: 'Fiction', slug: 'fiction' }, update: {} });
  const existingBook = await prisma.book.create({
    data: {
      isbn: isbns[0], title: 'Old title', author: 'Old author', publicationYear: 1999, description: 'Keep this stronger description',
      coverImageUrl: 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false', averageRating: 4, ratingsCount: 1,
      bookGenres: { create: { genreId: fiction.id } },
    },
  });
  await prisma.userBook.create({ data: { userId: user.id, bookId: existingBook.id, status: 'read', userRating: 4 } });
  const review = await prisma.review.create({ data: { userId: user.id, bookId: existingBook.id, rating: 4, reviewText: 'Keep my review', likesCount: 1 } });
  await prisma.reviewLike.create({ data: { userId: user.id, reviewId: review.id } });

  t.after(async () => {
    await prisma.book.deleteMany({ where: { isbn: { in: isbns } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    const createdGenreIds = (await prisma.genre.findMany({ where: { id: { notIn: [...priorGenreIds] }, bookGenres: { none: {} } } })).map(genre => genre.id);
    if (createdGenreIds.length) await prisma.genre.deleteMany({ where: { id: { in: createdGenreIds } } });
    await prisma.$disconnect();
  });

  const artifact = {
    artifactVersion: CATALOG_ARTIFACT_VERSION,
    resolverVersion: CATALOG_RESOLVER_VERSION,
    entries: [
      resolvedEntry(existingSource, isbns[0], { description: null }),
      resolvedEntry(newSource, isbns[1]),
      unresolvedEntry(reviewSource, 'needs_review'),
      unresolvedEntry(failedSource, 'failed'),
    ],
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('artifact import must remain offline'); };
  try {
    const beforeDryRun = await prisma.book.findUnique({ where: { id: existingBook.id }, include: { bookGenres: true } });
    const dryRun = await importResolvedCatalog(prisma, artifact, { apply: false });
    assert.deepEqual(dryRun, { created: 1, updated: 1, unchanged: 0, skipped: 2, failed: 0, resolved: 2 });
    assert.deepEqual(await prisma.book.findUnique({ where: { id: existingBook.id }, include: { bookGenres: true } }), beforeDryRun);
    assert.equal(await prisma.book.findUnique({ where: { isbn: isbns[1] } }), null);

    const firstApply = await importResolvedCatalog(prisma, artifact, { apply: true });
    assert.deepEqual(firstApply, { created: 1, updated: 1, unchanged: 0, skipped: 2, failed: 0, resolved: 2 });
    const updated = await prisma.book.findUnique({ where: { isbn: isbns[0] }, include: { bookGenres: { include: { genre: true } } } });
    assert.equal(updated.id, existingBook.id);
    assert.equal(updated.title, existingSource.title);
    assert.equal(updated.description, 'Keep this stronger description');
    assert.equal(updated.coverImageUrl, 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false');
    assert.equal(Number(updated.averageRating), 4);
    assert.equal(updated.ratingsCount, 1);
    assert.deepEqual(updated.bookGenres.map(row => row.genre.slug).sort(), ['fiction', 'history']);
    assert.equal(await prisma.userBook.count({ where: { userId: user.id, bookId: existingBook.id, userRating: 4 } }), 1);
    assert.equal(await prisma.review.count({ where: { id: review.id, userId: user.id, bookId: existingBook.id, rating: 4 } }), 1);
    assert.equal(await prisma.reviewLike.count({ where: { userId: user.id, reviewId: review.id } }), 1);
    assert.equal(await prisma.book.count({ where: { isbn: { in: [isbns[2], isbns[3]] } } }), 0);

    const created = await prisma.book.findUnique({ where: { isbn: isbns[1] } });
    assert.equal(created.averageRating, null);
    assert.equal(created.ratingsCount, 0);
    const secondApply = await importResolvedCatalog(prisma, artifact, { apply: true });
    assert.deepEqual(secondApply, { created: 0, updated: 0, unchanged: 2, skipped: 2, failed: 0, resolved: 2 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
