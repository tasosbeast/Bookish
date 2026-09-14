import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: Publication Date Foundation v1 API and database semantics',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const bookIds = [];
    let genreId;

    t.after(async () => {
      if (bookIds.length) {
        await prisma.bookGenre.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (genreId) {
        await prisma.genre.delete({ where: { id: genreId } });
      }
      await prisma.$disconnect();
    });

    const genre = await prisma.genre.create({
      data: { name: `PubDateGenre ${tag}`, slug: `pubdate-${tag}` },
    });
    genreId = genre.id;

    // 1. Create a Book with publicationDate = null, publicationYear = 2024
    const bookWithoutDate = await prisma.book.create({
      data: {
        title: `Book Without Date ${tag}`,
        author: `Author ${tag}`,
        publicationYear: 2024,
        publicationDate: null,
        bookGenres: { create: { genreId } },
      },
    });
    bookIds.push(bookWithoutDate.id);

    // 2. Create a Book with publicationDate = 2026-09-22, publicationYear = 2026
    const bookWithDate = await prisma.book.create({
      data: {
        title: `Book With Date ${tag}`,
        author: `Author ${tag}`,
        publicationYear: 2026,
        publicationDate: new Date('2026-09-22T00:00:00.000Z'),
        bookGenres: { create: { genreId } },
      },
    });
    bookIds.push(bookWithDate.id);

    // 3. Verify Prisma model / database persistence
    const fetchedWithout = await prisma.book.findUnique({ where: { id: bookWithoutDate.id } });
    assert.equal(fetchedWithout.publicationDate, null, 'Prisma returns null for unset publicationDate');
    assert.equal(fetchedWithout.publicationYear, 2024, 'publicationYear remains 2024');

    const fetchedWith = await prisma.book.findUnique({ where: { id: bookWithDate.id } });
    assert.ok(fetchedWith.publicationDate instanceof Date, 'Prisma returns Date instance');
    assert.equal(fetchedWith.publicationDate.toISOString().slice(0, 10), '2026-09-22', 'Date stored correctly in PostgreSQL DATE column');
    assert.equal(fetchedWith.publicationYear, 2026, 'publicationYear remains 2026');

    // 4. GET /api/books exposes publicationDate: "YYYY-MM-DD" | null
    const listRes = await request(app)
      .get('/api/books')
      .query({ genre: genre.slug, sort: 'publicationYear', order: 'asc' })
      .expect(200);

    assert.equal(listRes.body.data.length, 2);
    const itemWithout = listRes.body.data.find(b => b.id === bookWithoutDate.id);
    const itemWith = listRes.body.data.find(b => b.id === bookWithDate.id);

    assert.ok(itemWithout, 'Found book without date in list');
    assert.equal(itemWithout.publicationDate, null, 'GET /api/books serializes null publicationDate as null');
    assert.equal(itemWithout.publicationYear, 2024, 'GET /api/books preserves publicationYear');

    assert.ok(itemWith, 'Found book with date in list');
    assert.equal(itemWith.publicationDate, '2026-09-22', 'GET /api/books serializes publicationDate as "2026-09-22"');
    assert.equal(itemWith.publicationYear, 2026, 'GET /api/books preserves publicationYear');

    // 5. GET /api/books/:id exposes publicationDate
    const detailWithout = await request(app).get(`/api/books/${bookWithoutDate.id}`).expect(200);
    assert.equal(detailWithout.body.data.publicationDate, null, 'Detail endpoint serializes null publicationDate as null');
    assert.equal(detailWithout.body.data.publicationYear, 2024);

    const detailWith = await request(app).get(`/api/books/${bookWithDate.id}`).expect(200);
    assert.equal(detailWith.body.data.publicationDate, '2026-09-22', 'Detail endpoint serializes publicationDate as "2026-09-22"');
    assert.equal(detailWith.body.data.publicationYear, 2026);

    // 6. Timezone safety: session timezone change does not shift calendar day
    await prisma.$executeRawUnsafe("SET timezone = 'Asia/Tokyo'");
    const detailWithTzTokyo = await request(app).get(`/api/books/${bookWithDate.id}`).expect(200);
    assert.equal(detailWithTzTokyo.body.data.publicationDate, '2026-09-22', 'Date does not shift in Asia/Tokyo');

    await prisma.$executeRawUnsafe("SET timezone = 'America/New_York'");
    const detailWithTzNy = await request(app).get(`/api/books/${bookWithDate.id}`).expect(200);
    assert.equal(detailWithTzNy.body.data.publicationDate, '2026-09-22', 'Date does not shift in America/New_York');

    await prisma.$executeRawUnsafe("SET timezone = 'UTC'");

    // 7. Verify existing catalog rows in database remain null (no backfill occurred)
    const existingBooksWithDateCount = await prisma.book.count({
      where: {
        id: { notIn: bookIds },
        publicationDate: { not: null },
      },
    });
    assert.equal(existingBooksWithDateCount, 0, 'No existing books have publicationDate populated');
  }
);
