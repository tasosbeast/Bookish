import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { importCatalogCsv, CsvCatalogError } from '../../scripts/catalog/csv-import.js';

function isbnAt(index) {
  const firstTwelve = `978${String(index).padStart(9, '0')}`;
  const total = [...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${firstTwelve}${(10 - total % 10) % 10}`;
}

test('PostgreSQL: CSV catalog import preserves existing Book IDs, ratings, reviews, and relations', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const seed = Number.parseInt(tag, 16) % 800000000 + 100000000;

  const existingIsbn1 = isbnAt(seed);
  const existingIsbn2 = isbnAt(seed + 1);
  const existingIsbn3 = isbnAt(seed + 2);
  const newIsbn1 = isbnAt(seed + 10);
  const newIsbn2 = isbnAt(seed + 11);
  const newIsbn3 = isbnAt(seed + 12);

  const trackedIsbns = [existingIsbn1, existingIsbn2, existingIsbn3, newIsbn1, newIsbn2, newIsbn3];

  assert.equal(await prisma.book.count({ where: { isbn: { in: trackedIsbns } } }), 0, 'Test requires unused disposable ISBNs');

  const user = await prisma.user.create({
    data: {
      username: `csvuser_${tag}`,
      email: `csvuser_${tag}@example.com`,
      passwordHash: 'integration-test-only',
    },
  });

  // Book 1: Exact match candidate
  const existingBook1 = await prisma.book.create({
    data: {
      isbn: existingIsbn1,
      title: `Existing Book 1 ${tag}`,
      author: `Existing Author 1 ${tag}`,
      description: 'Original description 1',
      publicationYear: 2010,
      coverImageUrl: 'https://example.com/cover1.jpg',
      averageRating: 4.5,
      ratingsCount: 1,
    },
  });

  // Attach UserBook and Review and Like to Book 1
  const userBook = await prisma.userBook.create({
    data: {
      userId: user.id,
      bookId: existingBook1.id,
      status: 'read',
      userRating: 5,
    },
  });

  const review = await prisma.review.create({
    data: {
      userId: user.id,
      bookId: existingBook1.id,
      rating: 5,
      reviewText: 'Outstanding book!',
      likesCount: 1,
    },
  });

  const reviewLike = await prisma.reviewLike.create({
    data: {
      userId: user.id,
      reviewId: review.id,
    },
  });

  // Book 2: Work match candidate (same title/author, but will have a different ISBN in CSV)
  const existingBook2 = await prisma.book.create({
    data: {
      isbn: existingIsbn2,
      title: `Existing Work 2 ${tag}`,
      author: `Existing Author 2 ${tag}`,
      description: 'Original description 2',
      publicationYear: 2015,
      coverImageUrl: 'https://example.com/cover2.jpg',
      averageRating: 3.0,
      ratingsCount: 1,
    },
  });

  // Book 3: ISBN conflict candidate (DB has title A, CSV will have title B with same ISBN)
  const existingBook3 = await prisma.book.create({
    data: {
      isbn: existingIsbn3,
      title: `Conflict Target Title ${tag}`,
      author: `Conflict Author ${tag}`,
    },
  });

  t.after(async () => {
    await prisma.reviewLike.deleteMany({ where: { userId: user.id } });
    await prisma.review.deleteMany({ where: { userId: user.id } });
    await prisma.userBook.deleteMany({ where: { userId: user.id } });
    await prisma.book.deleteMany({ where: { isbn: { in: trackedIsbns } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  // Step A: Dry Run with mixed rows:
  // - 1 exact ISBN match (Book 1)
  // - 1 existing work match with different ISBN (Book 2's title/author with newIsbn1)
  // - 2 brand new books (newIsbn2, newIsbn3)
  const cleanCsv = [
    'title,author,isbn',
    `"${existingBook1.title}","${existingBook1.author}",${existingIsbn1}`, // exact match
    `"${existingBook2.title}","${existingBook2.author}",${newIsbn1}`,       // existing work match
    `"Brand New Book A ${tag}","New Author A",${newIsbn2}`,               // new book 1
    `"Brand New Book B ${tag}","New Author B",${newIsbn3}`,               // new book 2
  ].join('\n');

  const initialBookCount = await prisma.book.count({ where: { isbn: { in: trackedIsbns } } });
  assert.equal(initialBookCount, 3);

  // Dry run: zero writes
  const dryRun = await importCatalogCsv(prisma, cleanCsv, { apply: false });
  assert.equal(dryRun.summary.sourceRows, 4);
  assert.equal(dryRun.summary.validRows, 4);
  assert.equal(dryRun.summary.invalidRows, 0);
  assert.equal(dryRun.summary.matchedExactIsbn, 1);
  assert.equal(dryRun.summary.matchedExistingWork, 1);
  assert.equal(dryRun.summary.newBooks, 2);
  assert.equal(dryRun.summary.conflicts, 0);
  assert.equal(dryRun.summary.created, 0);
  assert.equal(dryRun.summary.updated, 0);

  // Verify no DB changes happened during dry-run
  assert.equal(await prisma.book.count({ where: { isbn: { in: trackedIsbns } } }), 3);

  // Step B: Dirty Apply should fail and create NOTHING
  const dirtyCsv = [
    cleanCsv,
    `"Wrong Title","Wrong Author",${existingIsbn3}`, // ISBN conflict with Book 3
  ].join('\n');

  await assert.rejects(
    async () => {
      await importCatalogCsv(prisma, dirtyCsv, { apply: true });
    },
    err => {
      assert(err instanceof CsvCatalogError);
      assert.equal(err.code, 'preflight_failed');
      assert.equal(err.details.summary.conflicts, 1);
      return true;
    }
  );

  // Still no new books created!
  assert.equal(await prisma.book.count({ where: { isbn: { in: trackedIsbns } } }), 3);

  // Step C: Clean Apply
  const applyResult = await importCatalogCsv(prisma, cleanCsv, { apply: true });
  assert.equal(applyResult.summary.matchedExactIsbn, 1);
  assert.equal(applyResult.summary.matchedExistingWork, 1);
  assert.equal(applyResult.summary.newBooks, 2);
  assert.equal(applyResult.summary.created, 2);
  assert.equal(applyResult.summary.updated, 0);

  // Verify exactly 5 books now exist (3 original + 2 new)
  assert.equal(await prisma.book.count({ where: { isbn: { in: trackedIsbns } } }), 5);

  // Step D: Verify Book 1 was completely untouched
  const book1After = await prisma.book.findUnique({ where: { id: existingBook1.id } });
  assert.equal(book1After.id, existingBook1.id);
  assert.equal(book1After.isbn, existingIsbn1);
  assert.equal(book1After.title, existingBook1.title);
  assert.equal(book1After.description, 'Original description 1');
  assert.equal(book1After.coverImageUrl, 'https://example.com/cover1.jpg');
  assert.equal(Number(book1After.averageRating), 4.5);
  assert.equal(book1After.ratingsCount, 1);

  // Verify UserBook, Review, and ReviewLike are unchanged
  const ubAfter = await prisma.userBook.findUnique({
    where: { userId_bookId: { userId: user.id, bookId: existingBook1.id } },
  });
  assert.equal(ubAfter.id, userBook.id);
  assert.equal(ubAfter.userRating, 5);

  const reviewAfter = await prisma.review.findUnique({ where: { id: review.id } });
  assert.equal(reviewAfter.reviewText, 'Outstanding book!');

  const likeAfter = await prisma.reviewLike.findUnique({
    where: { userId_reviewId: { userId: user.id, reviewId: review.id } },
  });
  assert.ok(likeAfter);

  // Step E: Verify created books have correct fields
  const createdBookA = await prisma.book.findUnique({ where: { isbn: newIsbn2 } });
  assert.ok(createdBookA);
  assert.equal(createdBookA.title, `Brand New Book A ${tag}`);
  assert.equal(createdBookA.author, 'New Author A');
  assert.equal(createdBookA.description, null);
  assert.equal(createdBookA.publicationYear, null);
  assert.equal(createdBookA.coverImageUrl, `https://covers.openlibrary.org/b/isbn/${newIsbn2}-L.jpg?default=false`);

  // Step F: Idempotency - second run
  const secondRunDry = await importCatalogCsv(prisma, cleanCsv, { apply: false });
  assert.equal(secondRunDry.summary.matchedExactIsbn, 3); // Book 1 + New Book A + New Book B
  assert.equal(secondRunDry.summary.matchedExistingWork, 1); // Book 2
  assert.equal(secondRunDry.summary.newBooks, 0);
  assert.equal(secondRunDry.summary.created, 0);

  const secondRunApply = await importCatalogCsv(prisma, cleanCsv, { apply: true });
  assert.equal(secondRunApply.summary.matchedExactIsbn, 3);
  assert.equal(secondRunApply.summary.matchedExistingWork, 1);
  assert.equal(secondRunApply.summary.newBooks, 0);
  assert.equal(secondRunApply.summary.created, 0);
  assert.equal(await prisma.book.count({ where: { isbn: { in: trackedIsbns } } }), 5);
});
