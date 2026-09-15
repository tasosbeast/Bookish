import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: GET /api/releases rolling date windows, sorting, limits and database semantics',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const bookIds = [];
    let genreId;

    t.after(async () => {
      if (bookIds.length) {
        await prisma.bookGenre.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.releaseMetadataSource.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (genreId) {
        await prisma.genre.delete({ where: { id: genreId } });
      }
      await prisma.$disconnect();
    });

    const genre = await prisma.genre.create({
      data: { name: `ReleaseGenre ${tag}`, slug: `release-${tag}` },
    });
    genreId = genre.id;

    const asOf = '2026-09-15';

    // Helper to create test books
    async function createTestBook(title, publicationDate, options = {}) {
      const book = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author: `Author ${tag}`,
          publicationYear: options.publicationYear ?? (publicationDate ? Number(publicationDate.slice(0, 4)) : 2026),
          publicationDate: publicationDate ? new Date(`${publicationDate}T00:00:00.000Z`) : null,
          averageRating: options.averageRating ?? null,
          isbn: options.isbn ?? `978${Math.floor(1000000000 + Math.random() * 9000000000)}`,
          bookGenres: { create: { genreId } },
          ...(options.withProvenance && {
            releaseMetadataSource: {
              create: {
                provider: 'prh',
                sourceUrl: 'https://example.com/source',
                sourceIsbn: `978${Math.floor(1000000000 + Math.random() * 9000000000)}`,
                verifiedPublicationDate: new Date(`${publicationDate}T00:00:00.000Z`),
                lastVerifiedAt: new Date(),
              },
            },
          }),
        },
      });
      bookIds.push(book.id);
      return book;
    }

    // 1. publicationDate null
    const bNull = await createTestBook('Book Null Date', null);
    // 2. publicationYear only
    const bYearOnly = await createTestBook('Book Year Only', null, { publicationYear: 2026 });
    // 3. exactly today: 2026-09-15
    const bToday = await createTestBook('Book Today', '2026-09-15');
    // 4. 90 days before: 2026-06-17
    const b90DaysAgo = await createTestBook('Book 90 Days Ago', '2026-06-17');
    // 5. 91 days before: 2026-06-16
    const b91DaysAgo = await createTestBook('Book 91 Days Ago', '2026-06-16');
    // 6. tomorrow: 2026-09-16
    const bTomorrow = await createTestBook('Book Tomorrow', '2026-09-16');
    // 7. 180 days after: 2027-03-14
    const b180DaysFuture = await createTestBook('Book 180 Days Future', '2027-03-14');
    // 8. 181 days after: 2027-03-15
    const b181DaysFuture = await createTestBook('Book 181 Days Future', '2027-03-15');
    // 9. Book with provenance
    const bWithProv = await createTestBook('Book With Provenance', '2026-09-10', { withProvenance: true });
    // 10 & 11: Two books on same day for tie-breaking
    const bTieA = await createTestBook('Book Tie A', '2026-08-01');
    const bTieB = await createTestBook('Book Tie B', '2026-08-01');

    // Make request to GET /api/releases with explicit asOf
    const res = await request(app)
      .get('/api/releases')
      .query({ asOf, limit: 50 })
      .expect(200);

    // Verify response structure
    assert.equal(res.body.asOf, '2026-09-15');
    assert.deepEqual(res.body.windows, {
      newReleases: {
        from: '2026-06-17',
        to: '2026-09-15',
      },
      upcoming: {
        fromExclusive: '2026-09-15',
        to: '2027-03-14',
      },
    });

    const newIds = res.body.newReleases.map(b => b.id);
    const upIds = res.body.upcoming.map(b => b.id);

    // 1 & 2: publicationDate null / year-only excluded
    assert.ok(!newIds.includes(bNull.id), 'null date excluded from newReleases');
    assert.ok(!upIds.includes(bNull.id), 'null date excluded from upcoming');
    assert.ok(!newIds.includes(bYearOnly.id), 'year-only excluded from newReleases');
    assert.ok(!upIds.includes(bYearOnly.id), 'year-only excluded from upcoming');

    // 3: exactly today included in newReleases
    assert.ok(newIds.includes(bToday.id), 'today included in newReleases');

    // 4: exactly today excluded from upcoming
    assert.ok(!upIds.includes(bToday.id), 'today excluded from upcoming');

    // 5: 90 days before included in newReleases
    assert.ok(newIds.includes(b90DaysAgo.id), '90 days ago included in newReleases');

    // 6: 91 days before excluded
    assert.ok(!newIds.includes(b91DaysAgo.id), '91 days ago excluded from newReleases');

    // 7: tomorrow included in upcoming
    assert.ok(upIds.includes(bTomorrow.id), 'tomorrow included in upcoming');

    // 8: 180 days after included in upcoming
    assert.ok(upIds.includes(b180DaysFuture.id), '180 days future included in upcoming');

    // 9: 181 days after excluded from upcoming
    assert.ok(!upIds.includes(b181DaysFuture.id), '181 days future excluded from upcoming');

    // 10: New Releases sorted newest-first
    const filteredNew = res.body.newReleases.filter(b => bookIds.includes(b.id));
    for (let i = 0; i < filteredNew.length - 1; i++) {
      assert.ok(filteredNew[i].publicationDate >= filteredNew[i + 1].publicationDate, 'newReleases sorted desc');
    }

    // 11: Upcoming sorted nearest-first
    const filteredUp = res.body.upcoming.filter(b => bookIds.includes(b.id));
    for (let i = 0; i < filteredUp.length - 1; i++) {
      assert.ok(filteredUp[i].publicationDate <= filteredUp[i + 1].publicationDate, 'upcoming sorted asc');
    }

    // 12: Deterministic tie-breaking by id
    const ties = filteredNew.filter(b => b.publicationDate === '2026-08-01');
    assert.equal(ties.length, 2);
    assert.ok(ties[0].id < ties[1].id, 'tie-breaker sorts by id asc');

    // 13: Date serialization format
    for (const b of [...res.body.newReleases, ...res.body.upcoming]) {
      assert.match(b.publicationDate, /^\d{4}-\d{2}-\d{2}$/);
    }

    // 14: Limit behavior
    const limitRes = await request(app)
      .get('/api/releases')
      .query({ asOf, limit: 1 })
      .expect(200);
    assert.ok(limitRes.body.newReleases.length <= 1);
    assert.ok(limitRes.body.upcoming.length <= 1);

    // 15: No provenance leakage
    const foundProvBook = res.body.newReleases.find(b => b.id === bWithProv.id);
    assert.ok(foundProvBook, 'book with provenance returned');
    assert.equal(foundProvBook.releaseMetadataSource, undefined);
    assert.equal(foundProvBook.provider, undefined);
    assert.equal(foundProvBook.sourceUrl, undefined);
    assert.equal(foundProvBook.sourceIsbn, undefined);
  }
);
