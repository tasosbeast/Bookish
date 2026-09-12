import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { repairLaunchCatalog, RepairCatalogError } from '../../scripts/catalog/repair-launch.js';
import { coverImageUrl, importCatalogCsv } from '../../scripts/catalog/csv-import.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function isbnAt(index) {
  const firstTwelve = `978${String(index).padStart(9, '0')}`;
  const total = [...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${firstTwelve}${(10 - total % 10) % 10}`;
}

test('PostgreSQL: launch catalog repair preserves Book.id, user ratings, reviews, likes, and relations', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const seed = Number.parseInt(tag, 16) % 800000000 + 200000000;

  const oldIsbn1 = isbnAt(seed);
  const desiredIsbn1 = isbnAt(seed + 1);

  const oldIsbn2 = isbnAt(seed + 2);
  const desiredIsbn2 = isbnAt(seed + 3);

  // Same-ISBN title repair
  const sameIsbn = isbnAt(seed + 4);

  // Collision target ISBN
  const collisionIsbn = isbnAt(seed + 5);

  const trackedIsbns = [oldIsbn1, desiredIsbn1, oldIsbn2, desiredIsbn2, sameIsbn, collisionIsbn];

  assert.equal(await prisma.book.count({ where: { isbn: { in: trackedIsbns } } }), 0, 'Test requires unused disposable ISBNs');

  const user = await prisma.user.create({
    data: {
      username: `repairuser_${tag}`,
      email: `repairuser_${tag}@example.com`,
      passwordHash: 'integration-test-only',
    },
  });

  // Book 1: with UserBook, Review, ReviewLike
  const book1 = await prisma.book.create({
    data: {
      isbn: oldIsbn1,
      title: `Old Title 1 ${tag}`,
      author: `Old Author 1 ${tag}`,
      description: 'Preserved description 1',
      publicationYear: 2012,
      coverImageUrl: 'https://example.com/old-cover-1.jpg',
      averageRating: 4.5,
      ratingsCount: 1,
    },
  });

  const userBook1 = await prisma.userBook.create({
    data: {
      userId: user.id,
      bookId: book1.id,
      status: 'read',
      userRating: 5,
    },
  });

  const review1 = await prisma.review.create({
    data: {
      userId: user.id,
      bookId: book1.id,
      rating: 5,
      reviewText: 'Review before repair!',
      likesCount: 1,
    },
  });

  const reviewLike1 = await prisma.reviewLike.create({
    data: {
      userId: user.id,
      reviewId: review1.id,
    },
  });

  // Book 2: standard repair
  const book2 = await prisma.book.create({
    data: {
      isbn: oldIsbn2,
      title: `Old Title 2 ${tag}`,
      author: `Old Author 2 ${tag}`,
      description: 'Preserved description 2',
      publicationYear: 2018,
    },
  });

  // Book 3: same-ISBN title/author repair
  const book3 = await prisma.book.create({
    data: {
      isbn: sameIsbn,
      title: `Old Title 3 ${tag}`,
      author: `Old Author 3 ${tag}`,
      coverImageUrl: 'https://example.com/custom-same-cover.jpg',
    },
  });

  // Colliding book for collision test
  const collidingBook = await prisma.book.create({
    data: {
      isbn: collisionIsbn,
      title: `Colliding Book ${tag}`,
      author: `Colliding Author ${tag}`,
    },
  });

  t.after(async () => {
    await prisma.reviewLike.deleteMany({ where: { userId: user.id } });
    await prisma.review.deleteMany({ where: { userId: user.id } });
    await prisma.userBook.deleteMany({ where: { userId: user.id } });
    await prisma.book.deleteMany({ where: { id: { in: [book1.id, book2.id, book3.id, collidingBook.id] } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  const testManifest = [
    {
      oldIsbn: oldIsbn1,
      expectedCurrentTitle: `Old Title 1 ${tag}`,
      expectedCurrentAuthor: `Old Author 1 ${tag}`,
      desiredTitle: `Desired Title 1 ${tag}`,
      desiredAuthor: `Desired Author 1 ${tag}`,
      desiredIsbn: desiredIsbn1,
    },
    {
      oldIsbn: oldIsbn2,
      expectedCurrentTitle: `Old Title 2 ${tag}`,
      expectedCurrentAuthor: `Old Author 2 ${tag}`,
      desiredTitle: `Desired Title 2 ${tag}`,
      desiredAuthor: `Desired Author 2 ${tag}`,
      desiredIsbn: desiredIsbn2,
    },
    {
      oldIsbn: sameIsbn,
      expectedCurrentTitle: `Old Title 3 ${tag}`,
      expectedCurrentAuthor: `Old Author 3 ${tag}`,
      desiredTitle: `Desired Title 3 ${tag}`,
      desiredAuthor: `Desired Author 3 ${tag}`,
      desiredIsbn: sameIsbn,
    },
  ];

  // 1. Dry run: zero writes
  const dryRun = await repairLaunchCatalog(prisma, { apply: false, manifest: testManifest });
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.summary.readyToRepair, 3);
  assert.equal(dryRun.summary.updated, 0);

  const book1Before = await prisma.book.findUnique({ where: { id: book1.id } });
  assert.equal(book1Before.title, `Old Title 1 ${tag}`);
  assert.equal(book1Before.isbn, oldIsbn1);

  // 2. Preflight failure: Target ISBN collision blocks ALL writes
  const collisionManifest = [
    ...testManifest,
    {
      oldIsbn: isbnAt(seed + 20),
      expectedCurrentTitle: 'Nonexistent',
      expectedCurrentAuthor: 'Nonexistent',
      desiredTitle: 'Should Collide',
      desiredAuthor: 'Should Collide',
      desiredIsbn: collisionIsbn, // Already used by collidingBook
    },
  ];
  await assert.rejects(
    async () => repairLaunchCatalog(prisma, { apply: true, manifest: collisionManifest }),
    RepairCatalogError
  );

  // 3. Preflight failure: Missing old book blocks ALL writes
  const missingManifest = [
    ...testManifest,
    {
      oldIsbn: isbnAt(seed + 30),
      expectedCurrentTitle: 'Missing Book',
      expectedCurrentAuthor: 'Missing Author',
      desiredTitle: 'Target Title',
      desiredAuthor: 'Target Author',
      desiredIsbn: isbnAt(seed + 31),
    },
  ];
  await assert.rejects(
    async () => repairLaunchCatalog(prisma, { apply: true, manifest: missingManifest }),
    RepairCatalogError
  );

  // 4. Preflight failure: Unexpected title/author blocks ALL writes
  const conflictManifest = [
    {
      oldIsbn: oldIsbn1,
      expectedCurrentTitle: 'Unexpected Title',
      expectedCurrentAuthor: `Old Author 1 ${tag}`,
      desiredTitle: `Desired Title 1 ${tag}`,
      desiredAuthor: `Desired Author 1 ${tag}`,
      desiredIsbn: desiredIsbn1,
    },
  ];
  await assert.rejects(
    async () => repairLaunchCatalog(prisma, { apply: true, manifest: conflictManifest }),
    RepairCatalogError
  );

  // Assert DB completely unchanged after all failure tests
  const book1StillUnchanged = await prisma.book.findUnique({ where: { id: book1.id } });
  assert.equal(book1StillUnchanged.title, `Old Title 1 ${tag}`);
  assert.equal(book1StillUnchanged.isbn, oldIsbn1);

  // 5. Clean apply
  const applyResult = await repairLaunchCatalog(prisma, { apply: true, manifest: testManifest });
  assert.equal(applyResult.applied, true);
  assert.equal(applyResult.summary.updated, 3);

  // 6. User data guarantee checks
  const book1After = await prisma.book.findUnique({ where: { id: book1.id } });
  assert.ok(book1After);
  assert.equal(book1After.id, book1.id, 'Book 1 ID must remain unchanged');
  assert.equal(book1After.title, `Desired Title 1 ${tag}`);
  assert.equal(book1After.author, `Desired Author 1 ${tag}`);
  assert.equal(book1After.isbn, desiredIsbn1);
  assert.equal(book1After.coverImageUrl, coverImageUrl(desiredIsbn1));
  assert.equal(book1After.description, 'Preserved description 1');
  assert.equal(book1After.publicationYear, 2012);

  // UserBook check
  const userBookAfter = await prisma.userBook.findUnique({
    where: { userId_bookId: { userId: user.id, bookId: book1.id } },
  });
  assert.ok(userBookAfter);
  assert.equal(userBookAfter.id, userBook1.id, 'UserBook ID unchanged');
  assert.equal(userBookAfter.status, 'read');
  assert.equal(userBookAfter.userRating, 5);

  // Review check
  const reviewAfter = await prisma.review.findUnique({ where: { id: review1.id } });
  assert.ok(reviewAfter);
  assert.equal(reviewAfter.id, review1.id, 'Review ID unchanged');
  assert.equal(reviewAfter.bookId, book1.id);
  assert.equal(reviewAfter.rating, 5);
  assert.equal(reviewAfter.reviewText, 'Review before repair!');
  assert.equal(reviewAfter.likesCount, 1);

  // ReviewLike check
  const likeAfter = await prisma.reviewLike.findUnique({
    where: { userId_reviewId: { userId: user.id, reviewId: review1.id } },
  });
  assert.ok(likeAfter);
  assert.equal(likeAfter.id, reviewLike1.id, 'ReviewLike ID unchanged');

  // Book 3 check (same-ISBN title correction preserves coverImageUrl)
  const book3After = await prisma.book.findUnique({ where: { id: book3.id } });
  assert.equal(book3After.id, book3.id);
  assert.equal(book3After.title, `Desired Title 3 ${tag}`);
  assert.equal(book3After.author, `Desired Author 3 ${tag}`);
  assert.equal(book3After.isbn, sameIsbn);
  assert.equal(book3After.coverImageUrl, 'https://example.com/custom-same-cover.jpg');

  // 7. Idempotency test (second dry-run and apply)
  const secondDryRun = await repairLaunchCatalog(prisma, { apply: false, manifest: testManifest });
  assert.equal(secondDryRun.summary.alreadyRepaired, 3);
  assert.equal(secondDryRun.summary.readyToRepair, 0);

  const secondApply = await repairLaunchCatalog(prisma, { apply: true, manifest: testManifest });
  assert.equal(secondApply.summary.alreadyRepaired, 3);
  assert.equal(secondApply.summary.readyToRepair, 0);
  assert.equal(secondApply.summary.updated, 0);
});

test('PostgreSQL: CSV import dry-run no longer reports conflicts caused by repaired historical rows', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const representativeRepairs = [
    {
      oldIsbn: '9780345503800',
      expectedCurrentTitle: 'The Painted Man',
      expectedCurrentAuthor: 'Peter V. Brett',
      desiredTitle: 'The Warded Man',
      desiredAuthor: 'Peter V. Brett',
      desiredIsbn: '9780345503800',
    },
    {
      oldIsbn: '9780679763970',
      expectedCurrentTitle: "Captain Corelli's Mandolin",
      expectedCurrentAuthor: 'Louis de Bernieres',
      desiredTitle: "Corelli's Mandolin",
      desiredAuthor: 'Louis de Bernieres',
      desiredIsbn: '9780679763970',
    },
    {
      oldIsbn: '9780767903820',
      expectedCurrentTitle: 'Notes from a Big Country',
      expectedCurrentAuthor: 'Bill Bryson',
      desiredTitle: "I'm a Stranger Here Myself",
      desiredAuthor: 'Bill Bryson',
      desiredIsbn: '9780767903820',
    },
    {
      oldIsbn: '9780439554930',
      expectedCurrentTitle: "Harry Potter and the Philosopher's Stone",
      expectedCurrentAuthor: 'J. K. Rowling',
      desiredTitle: "Harry Potter and the Sorcerer's Stone",
      desiredAuthor: 'J. K. Rowling',
      desiredIsbn: '9780439554930',
    },
  ];

  const affectedIsbns = representativeRepairs.flatMap(r => [r.oldIsbn, r.desiredIsbn]);

  // Clean up any pre-existing rows with these ISBNs
  await prisma.userBook.deleteMany({ where: { book: { isbn: { in: affectedIsbns } } } });
  await prisma.book.deleteMany({ where: { isbn: { in: affectedIsbns } } });

  // Insert representative books with historical (unrepaired) metadata
  const createdBooks = [];
  for (const r of representativeRepairs) {
    const book = await prisma.book.create({
      data: {
        isbn: r.oldIsbn,
        title: r.expectedCurrentTitle,
        author: r.expectedCurrentAuthor,
      },
    });
    createdBooks.push(book);
  }

  t.after(async () => {
    await prisma.userBook.deleteMany({ where: { book: { isbn: { in: affectedIsbns } } } });
    await prisma.book.deleteMany({ where: { isbn: { in: affectedIsbns } } });
    await prisma.$disconnect();
  });

  const csvContent = await readFile(resolve('scripts/catalog-books.csv'), 'utf8');

  // Dry-run BEFORE repair: conflicts MUST be present for these historical rows
  const beforeRepairResult = await importCatalogCsv(prisma, csvContent, { apply: false });
  assert.ok(beforeRepairResult.summary.conflicts >= representativeRepairs.length, 'Should have conflicts before repair');

  const beforeConflictIsbns = new Set(beforeRepairResult.details.conflicts.map(c => c.isbn));
  for (const r of representativeRepairs) {
    // Each of these ISBNs or target ISBNs collides with the unrepaired historical row
    const causesConflict = beforeConflictIsbns.has(r.oldIsbn) || beforeConflictIsbns.has(r.desiredIsbn);
    assert.ok(causesConflict, `Expected conflict for ${r.oldIsbn} before repair`);
  }

  // Apply the repair
  const repairResult = await repairLaunchCatalog(prisma, { apply: true, manifest: representativeRepairs });
  assert.equal(repairResult.applied, true);
  assert.equal(repairResult.summary.updated, representativeRepairs.length);

  // Dry-run AFTER repair: conflicts caused by these rows MUST be resolved
  const afterRepairResult = await importCatalogCsv(prisma, csvContent, { apply: false });
  const afterConflictIsbns = new Set(afterRepairResult.details.conflicts.map(c => c.isbn));

  for (const r of representativeRepairs) {
    assert.ok(!afterConflictIsbns.has(r.oldIsbn), `Expected no conflict for ${r.oldIsbn} after repair`);
    assert.ok(!afterConflictIsbns.has(r.desiredIsbn), `Expected no conflict for ${r.desiredIsbn} after repair`);
  }
});

