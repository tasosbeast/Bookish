import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prisma } from '../../src/lib/prisma.js';
import {
  importReleaseCatalog,
  ReleaseCatalogError,
} from '../../scripts/catalog/release-catalog.js';

test('PostgreSQL: Supplemental Release Catalog v1 dry-run, apply, blockers, idempotency and stale preflight',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookish-release-test-'));
    const createdBookIds = [];

    const createdGenreIds = [];

    t.after(async () => {
      if (createdBookIds.length > 0) {
        await prisma.book.deleteMany({ where: { id: { in: createdBookIds } } });
      }
      if (createdGenreIds.length > 0) {
        await prisma.genre.deleteMany({ where: { id: { in: createdGenreIds } } });
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      await prisma.$disconnect();
    });

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

    const isbn1 = '9789999000109';
    const isbn2 = '9789999000116';
    const isbnStale = '9789999000123';

    // Clean any leftover test rows if prior run crashed
    await prisma.book.deleteMany({
      where: { isbn: { in: [isbn1, isbn2, isbnStale] } },
    });

    // 1. Dry run: valid CSV creates no database rows
    const dryCsvPath = path.join(tempDir, 'dry-run.csv');
    fs.writeFileSync(
      dryCsvPath,
      'title,author,isbn,publicationDate,coverImageUrl,genres,sourceUrl\n' +
      `Dry Run Book,Test Author,${isbn1},2025-06-15,https://example.com/cover1.jpg,fiction;science-fiction,https://example.com/source1\n`
    );

    const dryResult = await importReleaseCatalog(prisma, {
      source: dryCsvPath,
      apply: false,
    });

    assert.equal(dryResult.summary.sourceRows, 1);
    assert.equal(dryResult.summary.validRows, 1);
    assert.equal(dryResult.summary.newBooks, 1);
    assert.equal(dryResult.summary.created, 0);
    assert.equal(dryResult.summary.preflightSafe, true);

    const bookAfterDry = await prisma.book.findUnique({ where: { isbn: isbn1 } });
    assert.equal(bookAfterDry, null, 'Dry run created no rows in PostgreSQL');

    // 2. Blocker test: publicationDate out of bounds prevents apply
    const blockerCsvPath = path.join(tempDir, 'blocker.csv');
    fs.writeFileSync(
      blockerCsvPath,
      'title,author,isbn,publicationDate,coverImageUrl,genres,sourceUrl\n' +
      `Invalid Year Book,Test Author,${isbn1},2020-01-01,https://example.com/cover1.jpg,fiction,https://example.com/source1\n`
    );

    await assert.rejects(
      async () => {
        await importReleaseCatalog(prisma, {
          source: blockerCsvPath,
          apply: true,
        });
      },
      err => {
        assert.equal(err instanceof ReleaseCatalogError, true);
        assert.equal(err.code, 'preflight_blocked');
        return true;
      }
    );

    const bookAfterBlocker = await prisma.book.findUnique({ where: { isbn: isbn1 } });
    assert.equal(bookAfterBlocker, null, 'Blocked apply created no rows');

    // 3. Safe apply: creates Book and BookGenre rows, derives publicationYear
    const applyCsvPath = path.join(tempDir, 'apply.csv');
    fs.writeFileSync(
      applyCsvPath,
      'title,author,isbn,publicationDate,coverImageUrl,genres,sourceUrl\n' +
      `The 2025 Release,Notable Author,${isbn1},2025-09-20,https://example.com/notable.jpg,fiction;science-fiction,https://example.com/source-notable\n`
    );

    const applyResult = await importReleaseCatalog(prisma, {
      source: applyCsvPath,
      apply: true,
    });

    assert.equal(applyResult.summary.newBooks, 1);
    assert.equal(applyResult.summary.created, 1);
    assert.equal(applyResult.summary.preflightSafe, true);

    const bookInDb = await prisma.book.findUnique({
      where: { isbn: isbn1 },
      include: {
        bookGenres: {
          include: { genre: true },
        },
      },
    });

    assert.ok(bookInDb, 'Book was created in PostgreSQL');
    createdBookIds.push(bookInDb.id);
    assert.equal(bookInDb.title, 'The 2025 Release');
    assert.equal(bookInDb.author, 'Notable Author');
    assert.equal(bookInDb.publicationYear, 2025, 'publicationYear derived from publicationDate');
    assert.ok(bookInDb.publicationDate instanceof Date);
    assert.equal(bookInDb.publicationDate.toISOString().slice(0, 10), '2025-09-20');
    assert.equal(bookInDb.coverImageUrl, 'https://example.com/notable.jpg');

    const connectedGenreSlugs = bookInDb.bookGenres.map(bg => bg.genre.slug).sort();
    assert.deepEqual(connectedGenreSlugs, ['fiction', 'science-fiction']);

    // 4. Idempotency: second run classifies book as alreadyPresent, does not recreate
    const secondRunResult = await importReleaseCatalog(prisma, {
      source: applyCsvPath,
      apply: true,
    });

    assert.equal(secondRunResult.summary.sourceRows, 1);
    assert.equal(secondRunResult.summary.validRows, 1);
    assert.equal(secondRunResult.summary.newBooks, 0);
    assert.equal(secondRunResult.summary.alreadyPresent, 1);
    assert.equal(secondRunResult.summary.created, 0);
    assert.equal(secondRunResult.summary.preflightSafe, true);

    const totalBooksMatching = await prisma.book.count({ where: { isbn: isbn1 } });
    assert.equal(totalBooksMatching, 1, 'Exactly one book exists after idempotent re-run');

    // 5. Stale preflight: concurrent ISBN insertion triggers rollback
    const staleCsvPath = path.join(tempDir, 'stale.csv');
    fs.writeFileSync(
      staleCsvPath,
      'title,author,isbn,publicationDate,coverImageUrl,genres,sourceUrl\n' +
      `Batch Book 2,Author Two,${isbn2},2026-04-10,https://example.com/c2.jpg,fiction,https://example.com/s2\n` +
      `Batch Book Stale,Author Stale,${isbnStale},2026-05-15,https://example.com/cs.jpg,fiction,https://example.com/ss\n`
    );

    // DB proxy that simulates a concurrent writer inserting isbnStale right after preflight
    const proxyDb = new Proxy(prisma, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (fn, opts) => {
            const colliding = await prisma.book.create({
              data: {
                title: 'Colliding Book',
                author: 'Colliding Author',
                isbn: isbnStale,
                publicationYear: 2026,
              },
            });
            createdBookIds.push(colliding.id);
            return target.$transaction(fn, opts);
          };
        }
        return target[prop];
      },
    });

    await assert.rejects(
      async () => {
        await importReleaseCatalog(proxyDb, {
          source: staleCsvPath,
          apply: true,
        });
      },
      err => {
        assert.equal(err instanceof ReleaseCatalogError, true);
        assert.equal(err.code, 'stale_preflight');
        return true;
      }
    );

    // Verify batch book 2 was NOT created (whole batch rolled back)
    const book2InDb = await prisma.book.findUnique({ where: { isbn: isbn2 } });
    assert.equal(book2InDb, null, 'Concurrent collision rolled back entire batch');
  }
);
