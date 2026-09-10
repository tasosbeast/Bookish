import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { importLaunchCatalog, prepareLaunchCatalog } from '../../scripts/catalog/launch-import.js';

function isbnAt(index) {
  const firstTwelve = `978${String(index).padStart(9, '0')}`;
  const total = [...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${firstTwelve}${(10 - total % 10) % 10}`;
}

function fixtureSource(seed) {
  return Array.from({ length: 250 }, (_, index) => {
    const isbn = isbnAt(seed + index);
    return {
      key: `launch-fixture-${seed}-${index}`,
      title: `Launch Fixture Book ${index}`,
      author: `Launch Fixture Author ${index}`,
      preferredIsbn13: isbn,
      ...(index === 0 ? { pinnedIsbn13: isbn } : {}),
    };
  });
}

test('PostgreSQL: launch import preserves existing Book identity, ratings and relations', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const seed = Number.parseInt(tag, 16) % 900000000;
  const source = fixtureSource(seed);
  const entries = prepareLaunchCatalog(source);
  const existingIsbn = isbnAt(seed + 1000);
  const isbns = [...entries.map(entry => entry.isbn), existingIsbn];
  assert.equal(await prisma.book.count({ where: { isbn: { in: isbns } } }), 0, 'Test requires unused disposable ISBNs');

  const user = await prisma.user.create({ data: { username: `launch_${tag}`, email: `launch_${tag}@example.com`, passwordHash: 'integration-test-only' } });
  const existing = await prisma.book.create({
    data: {
      isbn: existingIsbn, title: entries[0].title, author: entries[0].author,
      description: 'Existing description', publicationYear: 2001, coverImageUrl: 'https://example.com/known-good-cover.jpg',
      averageRating: 4, ratingsCount: 1,
    },
  });
  await prisma.userBook.create({ data: { userId: user.id, bookId: existing.id, status: 'read', userRating: 4 } });
  const review = await prisma.review.create({ data: { userId: user.id, bookId: existing.id, rating: 4, reviewText: 'Keep this review', likesCount: 1 } });
  await prisma.reviewLike.create({ data: { userId: user.id, reviewId: review.id } });

  t.after(async () => {
    await prisma.book.deleteMany({ where: { isbn: { in: isbns } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  const before = await prisma.book.findUnique({ where: { id: existing.id } });
  const dryRun = await importLaunchCatalog(prisma, source, { apply: false });
  assert.deepEqual({ ...dryRun, unmappedExistingBooks: [] }, { sourceEntries: 250, matchedExactIsbn: 0, matchedExistingWork: 1, created: 249, updated: 0, conflicts: 0, invalidEntries: 0, unmappedExistingBooks: [] });
  assert.equal(await prisma.book.count({ where: { isbn: { in: isbns } } }), 1);

  const result = await importLaunchCatalog(prisma, source, { apply: true });
  assert.deepEqual(result, dryRun);
  const after = await prisma.book.findUnique({ where: { isbn: existingIsbn } });
  assert.deepEqual(after, before);
  assert.equal(await prisma.userBook.count({ where: { userId: user.id, bookId: existing.id, userRating: 4 } }), 1);
  assert.equal(await prisma.review.count({ where: { id: review.id, userId: user.id, bookId: existing.id, rating: 4 } }), 1);
  assert.equal(await prisma.reviewLike.count({ where: { userId: user.id, reviewId: review.id } }), 1);
  const created = await prisma.book.findUnique({ where: { isbn: entries[1].isbn } });
  assert.equal(created.description, null);
  assert.equal(created.publicationYear, null);
  assert.equal(created.coverImageUrl, `https://covers.openlibrary.org/b/isbn/${entries[1].isbn}-L.jpg?default=false`);
});
