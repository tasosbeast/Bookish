import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma.js';
import { syncPrhReleases } from '../../scripts/catalog/prh-sync.js';
import { serializePublicationDate } from '../../src/services/books.js';

function makeValidIsbn13(prefix) {
  const digits = String(prefix).padStart(12, '0').slice(-12);
  const full12 = digits.startsWith('978') || digits.startsWith('979') ? digits : `978${digits.slice(3)}`;
  const sum = [...full12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return `${full12}${check}`;
}

test('PostgreSQL: PRH release sync engine refresh, local divergence, discovery, and idempotency',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const createdBookIds = [];
    const createdGenreIds = [];

    const isbnRefresh = makeValidIsbn13('978999911111');
    const isbnDivergence = makeValidIsbn13('978999922222');
    const isbnDiscovery = makeValidIsbn13('978999933333');

    t.after(async () => {
      if (createdBookIds.length > 0) {
        await prisma.book.deleteMany({ where: { id: { in: createdBookIds } } });
      }
      // Also clean up any books with our test ISBNs
      await prisma.book.deleteMany({
        where: { isbn: { in: [isbnRefresh, isbnDivergence, isbnDiscovery] } },
      });
      if (createdGenreIds.length > 0) {
        await prisma.genre.deleteMany({ where: { id: { in: createdGenreIds } } });
      }
      await prisma.$disconnect();
    });

    // Ensure genres exist
    const g1 = await prisma.genre.upsert({
      where: { slug: 'fiction' },
      update: {},
      create: { name: 'Fiction', slug: 'fiction' },
    });
    const g2 = await prisma.genre.upsert({
      where: { slug: 'science-fiction' },
      update: {},
      create: { name: 'Science Fiction', slug: 'science-fiction' },
    });
    createdGenreIds.push(g1.id, g2.id);

    // Clean any leftover test rows
    await prisma.book.deleteMany({
      where: { isbn: { in: [isbnRefresh, isbnDivergence, isbnDiscovery] } },
    });

    // -------------------------------------------------------------
    // 1. REFRESH: Unchanged, Changed, Dry-Run, Apply
    // -------------------------------------------------------------
    const bookRefresh = await prisma.book.create({
      data: {
        title: 'Refresh Test Novel',
        author: 'Refresh Author',
        isbn: isbnRefresh,
        publicationDate: new Date('2026-07-15T00:00:00.000Z'),
        publicationYear: 2026,
      },
    });
    createdBookIds.push(bookRefresh.id);

    const sourceRefresh = await prisma.releaseMetadataSource.create({
      data: {
        bookId: bookRefresh.id,
        provider: 'prh',
        sourceIsbn: isbnRefresh,
        sourceUrl: `https://www.penguinrandomhouse.com/books/${isbnRefresh}`,
        verifiedPublicationDate: new Date('2026-07-15T00:00:00.000Z'),
        lastVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    // Dry-run with changed date
    const clientRefresh = {
      getTitleByIsbn: async (isbn) => {
        if (isbn === isbnRefresh) {
          return {
            isbn: isbnRefresh,
            title: 'Refresh Test Novel',
            author: 'Refresh Author',
            onsale: '2026-08-20',
          };
        }
        return null;
      },
      listTitlesByOnSaleRange: async () => ({ titles: [] }),
    };

    const dryRes = await syncPrhReleases(prisma, {
      client: clientRefresh,
      asOf: '2026-07-01',
      apply: false,
    });
    assert.equal(dryRes.summary.refresh.managedSources, 1);
    assert.equal(dryRes.summary.refresh.dateChanged, 1);
    assert.equal(dryRes.summary.refresh.updated, 0);

    const bookAfterDry = await prisma.book.findUnique({ where: { id: bookRefresh.id } });
    assert.equal(serializePublicationDate(bookAfterDry.publicationDate), '2026-07-15');

    // Apply with changed date
    const applyRes = await syncPrhReleases(prisma, {
      client: clientRefresh,
      asOf: '2026-07-01',
      apply: true,
    });
    assert.equal(applyRes.summary.refresh.dateChanged, 1);
    assert.equal(applyRes.summary.refresh.updated, 1);

    const bookAfterApply = await prisma.book.findUnique({ where: { id: bookRefresh.id } });
    assert.equal(serializePublicationDate(bookAfterApply.publicationDate), '2026-08-20');
    assert.equal(bookAfterApply.publicationYear, 2026);

    const sourceAfterApply = await prisma.releaseMetadataSource.findUnique({ where: { id: sourceRefresh.id } });
    assert.equal(serializePublicationDate(sourceAfterApply.verifiedPublicationDate), '2026-08-20');

    // -------------------------------------------------------------
    // 2. LOCAL DIVERGENCE PROTECTION
    // -------------------------------------------------------------
    // Simulate manual editor override on publicationDate
    await prisma.book.update({
      where: { id: bookRefresh.id },
      data: { publicationDate: new Date('2026-09-01T00:00:00.000Z') },
    });

    const clientDivergence = {
      getTitleByIsbn: async (isbn) => ({
        isbn,
        title: 'Refresh Test Novel',
        author: 'Refresh Author',
        onsale: '2026-10-15',
      }),
      listTitlesByOnSaleRange: async () => ({ titles: [] }),
    };

    const divRes = await syncPrhReleases(prisma, {
      client: clientDivergence,
      asOf: '2026-07-01',
      apply: true,
    });
    assert.equal(divRes.summary.refresh.localDivergence, 1);
    assert.equal(divRes.summary.refresh.updated, 0);

    const bookAfterDiv = await prisma.book.findUnique({ where: { id: bookRefresh.id } });
    assert.equal(serializePublicationDate(bookAfterDiv.publicationDate), '2026-09-01', 'Local date must be protected from overwrite');

    // -------------------------------------------------------------
    // 3. DISCOVERY: Dry-Run, Apply, Genres, Provenance
    // -------------------------------------------------------------
    const clientDiscovery = {
      getTitleByIsbn: async () => null,
      listTitlesByOnSaleRange: async () => ({
        titles: [
          {
            isbn: isbnDiscovery,
            workId: 987654,
            title: 'Discovered Postgres Novel',
            author: 'Discovery Author',
            onsale: '2026-08-15',
            format: { code: 'HC' },
            formatDescription: 'Hardcover',
            seoFriendlyUrl: '/books/987654/discovered-postgres-novel',
            _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover-disc.jpg' }],
            categories: [{ description: 'Science Fiction' }],
          },
        ],
      }),
    };

    // Dry-run discovery
    const dryDiscRes = await syncPrhReleases(prisma, {
      client: clientDiscovery,
      asOf: '2026-07-01',
      apply: false,
    });
    assert.equal(dryDiscRes.summary.discovery.plannedNew, 1);
    assert.equal(dryDiscRes.summary.discovery.created, 0);

    const bookBeforeApply = await prisma.book.findUnique({ where: { isbn: isbnDiscovery } });
    assert.equal(bookBeforeApply, null, 'Dry run created no book');

    // Apply discovery
    const applyDiscRes = await syncPrhReleases(prisma, {
      client: clientDiscovery,
      asOf: '2026-07-01',
      apply: true,
    });
    assert.equal(applyDiscRes.summary.discovery.plannedNew, 1);
    assert.equal(applyDiscRes.summary.discovery.created, 1);

    const createdBook = await prisma.book.findUnique({
      where: { isbn: isbnDiscovery },
      include: {
        bookGenres: { include: { genre: true } },
        releaseMetadataSource: true,
      },
    });
    assert.ok(createdBook);
    createdBookIds.push(createdBook.id);
    assert.equal(createdBook.title, 'Discovered Postgres Novel');
    assert.equal(createdBook.author, 'Discovery Author');
    assert.equal(serializePublicationDate(createdBook.publicationDate), '2026-08-15');
    assert.equal(createdBook.publicationYear, 2026);
    assert.equal(createdBook.coverImageUrl, 'https://images.penguinrandomhouse.com/cover-disc.jpg');

    // Check genre attached
    assert.equal(createdBook.bookGenres.length, 1);
    assert.equal(createdBook.bookGenres[0].genre.slug, 'science-fiction');

    // Check release metadata source attached
    assert.ok(createdBook.releaseMetadataSource);
    assert.equal(createdBook.releaseMetadataSource.provider, 'prh');
    assert.equal(createdBook.releaseMetadataSource.sourceIsbn, isbnDiscovery);
    assert.equal(serializePublicationDate(createdBook.releaseMetadataSource.verifiedPublicationDate), '2026-08-15');

    // -------------------------------------------------------------
    // 4. IDEMPOTENCY: Repeated discovery discovers 0 new books
    // -------------------------------------------------------------
    const repeatDiscRes = await syncPrhReleases(prisma, {
      client: clientDiscovery,
      asOf: '2026-07-01',
      apply: true,
    });
    assert.equal(repeatDiscRes.summary.discovery.alreadyInBookish, 1);
    assert.equal(repeatDiscRes.summary.discovery.plannedNew, 0);
    assert.equal(repeatDiscRes.summary.discovery.created, 0);
  }
);
