import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { enrichCatalogGenres } from '../../scripts/catalog/genre-enrichment.js';

test('PostgreSQL: catalog genre enrichment preserves Book.id, user data, replaces stale links, and leaves non-curated links untouched', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const seed = Number.parseInt(tag, 16) % 800000000 + 200000000;

  function isbnAt(index) {
    const firstTwelve = `978${String(index).padStart(9, '0')}`;
    const total = [...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0);
    return `${firstTwelve}${(10 - total % 10) % 10}`;
  }

  const curatedIsbn1 = isbnAt(seed);
  const curatedIsbn2 = isbnAt(seed + 1);
  const nonCuratedIsbn = isbnAt(seed + 2);

  const testSlug1 = `test-canon-1-${tag}`;
  const testSlug2 = `test-canon-2-${tag}`;
  const testSlugStale = `test-stale-${tag}`;
  const testSlugNonCurated = `test-noncurated-${tag}`;

  const taxonomy = [
    { name: `Canonical Genre 1 ${tag}`, slug: testSlug1 },
    { name: `Canonical Genre 2 ${tag}`, slug: testSlug2 },
  ];

  const catalogBooks = [
    { title: `Curated Title 1 ${tag}`, author: `Curated Author 1 ${tag}`, isbn: curatedIsbn1 },
    { title: `Curated Title 2 ${tag}`, author: `Curated Author 2 ${tag}`, isbn: curatedIsbn2 },
  ];

  const genresByIsbn = new Map([
    [curatedIsbn1, [testSlug1, testSlug2]],
    [curatedIsbn2, [testSlug1]],
  ]);

  let user, user2, curatedBook1, curatedBook2, nonCuratedBook, staleGenre, nonCuratedGenre, canonGenre1;

  try {
    user = await prisma.user.create({
      data: {
        username: `genre_user1_${tag}`,
        email: `genre_user1_${tag}@example.com`,
        passwordHash: 'integration-test-only',
      },
    });

    user2 = await prisma.user.create({
      data: {
        username: `genre_user2_${tag}`,
        email: `genre_user2_${tag}@example.com`,
        passwordHash: 'integration-test-only',
      },
    });

    staleGenre = await prisma.genre.create({
      data: {
        name: `Stale Genre ${tag}`,
        slug: testSlugStale,
      },
    });

    nonCuratedGenre = await prisma.genre.create({
      data: {
        name: `Non-Curated Genre ${tag}`,
        slug: testSlugNonCurated,
      },
    });

    canonGenre1 = await prisma.genre.create({
      data: {
        name: `Canonical Genre 1 ${tag}`,
        slug: testSlug1,
      },
    });

    // Curated Book 1: has exact ISBN, currently linked to staleGenre
    curatedBook1 = await prisma.book.create({
      data: {
        isbn: curatedIsbn1,
        title: `Curated Title 1 ${tag}`,
        author: `Curated Author 1 ${tag}`,
        description: 'Preserved description 1',
        publicationYear: 2020,
        coverImageUrl: 'https://example.com/cover1.jpg',
        averageRating: 4.0,
        ratingsCount: 1,
        bookGenres: {
          create: [{ genreId: staleGenre.id }],
        },
      },
    });

    // Curated Book 2: alternate edition in DB, linked to staleGenre
    curatedBook2 = await prisma.book.create({
      data: {
        isbn: isbnAt(seed + 10), // alternate edition ISBN
        title: `Curated Title 2 ${tag}`,
        author: `Curated Author 2 ${tag}`,
        description: 'Preserved description 2',
        publicationYear: 2021,
        coverImageUrl: 'https://example.com/cover2.jpg',
      },
    });

    // Non-curated Book: must never be modified
    nonCuratedBook = await prisma.book.create({
      data: {
        isbn: nonCuratedIsbn,
        title: `Non-Curated Book ${tag}`,
        author: `Non-Curated Author ${tag}`,
        bookGenres: {
          create: [{ genreId: nonCuratedGenre.id }],
        },
      },
    });

    // Relations on Curated Book 1: UserBook, Review, ReviewLike
    const userBook = await prisma.userBook.create({
      data: {
        userId: user.id,
        bookId: curatedBook1.id,
        status: 'read',
        userRating: 5,
      },
    });

    const review = await prisma.review.create({
      data: {
        userId: user.id,
        bookId: curatedBook1.id,
        rating: 5,
        reviewText: 'Outstanding integration test book',
        likesCount: 1,
      },
    });

    const reviewLike = await prisma.reviewLike.create({
      data: {
        userId: user2.id,
        reviewId: review.id,
      },
    });

    // 1. Dry run
    const dryRunResult = await enrichCatalogGenres(prisma, {
      apply: false,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(dryRunResult.summary.sourceBooks, 2);
    assert.equal(dryRunResult.summary.matchedExactIsbn, 1);
    assert.equal(dryRunResult.summary.matchedExistingWork, 1);
    assert.equal(dryRunResult.summary.newCanonicalGenres, 1); // testSlug2 needs creation
    assert.equal(dryRunResult.summary.existingCanonicalGenres, 1); // testSlug1 exists
    assert.equal(dryRunResult.summary.linksToAdd, 3); // 2 on book 1, 1 on book 2
    assert.equal(dryRunResult.summary.linksToRemove, 1); // 1 stale on book 1
    assert.equal(dryRunResult.summary.createdGenres, 0);
    assert.equal(dryRunResult.summary.addedLinks, 0);
    assert.equal(dryRunResult.summary.removedLinks, 0);

    // Verify zero DB changes after dry run
    const postDryRunBook1 = await prisma.book.findUnique({
      where: { id: curatedBook1.id },
      include: { bookGenres: true },
    });
    assert.equal(postDryRunBook1.bookGenres.length, 1);
    assert.equal(postDryRunBook1.bookGenres[0].genreId, staleGenre.id);

    // 2. Apply
    const applyResult = await enrichCatalogGenres(prisma, {
      apply: true,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(applyResult.summary.createdGenres, 1);
    assert.equal(applyResult.summary.addedLinks, 3);
    assert.equal(applyResult.summary.removedLinks, 1);
    assert.equal(applyResult.summary.bookRowsUpdated, 0);

    // 3. Verify Book records are untouched
    const reloadedBook1 = await prisma.book.findUnique({
      where: { id: curatedBook1.id },
      include: {
        bookGenres: {
          include: { genre: true },
        },
      },
    });

    assert.equal(reloadedBook1.id, curatedBook1.id);
    assert.equal(reloadedBook1.isbn, curatedIsbn1);
    assert.equal(reloadedBook1.title, curatedBook1.title);
    assert.equal(reloadedBook1.author, curatedBook1.author);
    assert.equal(reloadedBook1.description, 'Preserved description 1');
    assert.equal(reloadedBook1.publicationYear, 2020);
    assert.equal(reloadedBook1.coverImageUrl, 'https://example.com/cover1.jpg');

    // Verify Curated Book 1 genres: exactly testSlug1 and testSlug2, stale removed!
    const book1Slugs = reloadedBook1.bookGenres.map(bg => bg.genre.slug).sort();
    assert.deepEqual(book1Slugs, [testSlug1, testSlug2].sort());

    // Verify Curated Book 2 genres: exactly testSlug1
    const reloadedBook2 = await prisma.book.findUnique({
      where: { id: curatedBook2.id },
      include: {
        bookGenres: {
          include: { genre: true },
        },
      },
    });
    assert.equal(reloadedBook2.id, curatedBook2.id);
    assert.equal(reloadedBook2.isbn, isbnAt(seed + 10)); // preserved alternate edition ISBN
    assert.deepEqual(reloadedBook2.bookGenres.map(bg => bg.genre.slug), [testSlug1]);

    // 4. Verify Non-Curated Book is completely untouched!
    const reloadedNonCurated = await prisma.book.findUnique({
      where: { id: nonCuratedBook.id },
      include: {
        bookGenres: {
          include: { genre: true },
        },
      },
    });
    assert.equal(reloadedNonCurated.bookGenres.length, 1);
    assert.equal(reloadedNonCurated.bookGenres[0].genre.slug, testSlugNonCurated);

    // 5. Verify UserBook, Review, ReviewLike preserved
    const reloadedUserBook = await prisma.userBook.findUnique({
      where: { userId_bookId: { userId: user.id, bookId: curatedBook1.id } },
    });
    assert.ok(reloadedUserBook);
    assert.equal(reloadedUserBook.status, 'read');
    assert.equal(reloadedUserBook.userRating, 5);

    const reloadedReview = await prisma.review.findUnique({
      where: { id: review.id },
    });
    assert.ok(reloadedReview);
    assert.equal(reloadedReview.rating, 5);
    assert.equal(reloadedReview.reviewText, 'Outstanding integration test book');
    assert.equal(reloadedReview.likesCount, 1);

    const reloadedReviewLike = await prisma.reviewLike.findUnique({
      where: { userId_reviewId: { userId: user2.id, reviewId: review.id } },
    });
    assert.ok(reloadedReviewLike);

    // 6. Idempotency test: second apply produces 0 changes
    const secondApply = await enrichCatalogGenres(prisma, {
      apply: true,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });
    assert.equal(secondApply.summary.createdGenres, 0);
    assert.equal(secondApply.summary.addedLinks, 0);
    assert.equal(secondApply.summary.removedLinks, 0);
    assert.equal(secondApply.summary.booksNeedingChanges, 0);
    assert.equal(secondApply.summary.booksAlreadyCorrect, 2);
  } finally {
    // Teardown
    if (user2) {
      await prisma.reviewLike.deleteMany({ where: { userId: user2.id } }).catch(() => {});
    }
    if (user) {
      await prisma.review.deleteMany({ where: { userId: user.id } }).catch(() => {});
      await prisma.userBook.deleteMany({ where: { userId: user.id } }).catch(() => {});
    }
    const bookIds = [curatedBook1?.id, curatedBook2?.id, nonCuratedBook?.id].filter(Boolean);
    if (bookIds.length > 0) {
      await prisma.bookGenre.deleteMany({ where: { bookId: { in: bookIds } } }).catch(() => {});
      await prisma.book.deleteMany({ where: { id: { in: bookIds } } }).catch(() => {});
    }
    if (user) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (user2) await prisma.user.delete({ where: { id: user2.id } }).catch(() => {});
    const slugsToDelete = [testSlug1, testSlug2, testSlugStale, testSlugNonCurated];
    await prisma.genre.deleteMany({ where: { slug: { in: slugsToDelete } } }).catch(() => {});
  }
});
