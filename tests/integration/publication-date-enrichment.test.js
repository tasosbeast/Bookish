import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prisma } from '../../src/lib/prisma.js';
import {
  enrichCatalogPublicationDates,
  PublicationDateEnrichmentError,
} from '../../scripts/catalog/publication-date-enrichment.js';

test('PostgreSQL: Publication Date Enrichment Tool v1 dry-run, apply, blockers and idempotency',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookish-pubdate-test-'));
    const createdBookIds = [];
    const originalBooks = new Map();

    t.after(async () => {
      // Restore original books if any were modified
      for (const [id, original] of originalBooks.entries()) {
        await prisma.book.update({
          where: { id },
          data: { publicationDate: original.publicationDate },
        });
      }
      // Delete fixtures created specifically by this test
      if (createdBookIds.length > 0) {
        await prisma.book.deleteMany({ where: { id: { in: createdBookIds } } });
      }
      // Clean up temp files
      fs.rmSync(tempDir, { recursive: true, force: true });
      await prisma.$disconnect();
    });

    // Pick real ISBNs present in scripts/catalog-books.csv
    const isbn1 = '9780141439518'; // Pride and Prejudice (2003)
    const isbn2 = '9780141439556'; // Wuthering Heights (2003)

    let book1 = await prisma.book.findUnique({ where: { isbn: isbn1 } });
    if (!book1) {
      book1 = await prisma.book.create({
        data: {
          title: 'Pride and Prejudice',
          author: 'Jane Austen',
          isbn: isbn1,
          publicationYear: 2003,
          publicationDate: null,
        },
      });
      createdBookIds.push(book1.id);
    } else {
      originalBooks.set(book1.id, { publicationDate: book1.publicationDate });
      await prisma.book.update({ where: { id: book1.id }, data: { publicationDate: null } });
    }

    let book2 = await prisma.book.findUnique({ where: { isbn: isbn2 } });
    if (!book2) {
      book2 = await prisma.book.create({
        data: {
          title: 'Wuthering Heights',
          author: 'Emily Bronte',
          isbn: isbn2,
          publicationYear: 2003,
          publicationDate: null,
        },
      });
      createdBookIds.push(book2.id);
    } else {
      originalBooks.set(book2.id, { publicationDate: book2.publicationDate });
      await prisma.book.update({ where: { id: book2.id }, data: { publicationDate: null } });
    }

    // 1. Dry run writes nothing to database
    const fixtureCsvPath1 = path.join(tempDir, 'source1.csv');
    fs.writeFileSync(
      fixtureCsvPath1,
      `isbn,publicationDate,sourceUrl\n${isbn1},2003-05-27,https://example.com/source1\n`
    );

    const dryResult = await enrichCatalogPublicationDates(prisma, {
      source: fixtureCsvPath1,
      apply: false,
    });

    assert.equal(dryResult.summary.sourceRows, 1);
    assert.equal(dryResult.summary.matchedDatabaseBooks, 1);
    assert.equal(dryResult.summary.needsUpdate, 1);
    assert.equal(dryResult.summary.alreadyCorrect, 0);
    assert.equal(dryResult.summary.updated, 0);
    assert.equal(dryResult.summary.preflightSafe, true);

    const book1AfterDry = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(book1AfterDry.publicationDate, null, 'Dry run did not update publicationDate in PostgreSQL');

    // 2. Blocker test: publicationYear mismatch prevents apply
    const fixtureCsvMismatch = path.join(tempDir, 'source-mismatch.csv');
    fs.writeFileSync(
      fixtureCsvMismatch,
      `isbn,publicationDate,sourceUrl\n${isbn1},1999-05-27,https://example.com/source1\n` // 1999 vs db year 2003
    );

    await assert.rejects(
      () => enrichCatalogPublicationDates(prisma, { source: fixtureCsvMismatch, apply: true }),
      PublicationDateEnrichmentError
    );

    const book1AfterBlocked = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(book1AfterBlocked.publicationDate, null, 'Blocked apply did not modify database');

    // 3. Successful apply updates ONLY publicationDate atomically
    const applyResult = await enrichCatalogPublicationDates(prisma, {
      source: fixtureCsvPath1,
      apply: true,
    });

    assert.equal(applyResult.summary.sourceRows, 1);
    assert.equal(applyResult.summary.needsUpdate, 1);
    assert.equal(applyResult.summary.updated, 1);
    assert.equal(applyResult.summary.preflightSafe, true);

    const book1AfterApply = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.ok(book1AfterApply.publicationDate instanceof Date);
    assert.equal(
      book1AfterApply.publicationDate.toISOString().slice(0, 10),
      '2003-05-27',
      'publicationDate updated accurately in PostgreSQL DATE column'
    );
    assert.equal(book1AfterApply.title, book1.title);
    assert.equal(book1AfterApply.author, book1.author);
    assert.equal(book1AfterApply.publicationYear, book1.publicationYear);

    // 4. Idempotency: second dry run and apply produce 0 updates
    const secondDry = await enrichCatalogPublicationDates(prisma, {
      source: fixtureCsvPath1,
      apply: false,
    });
    assert.equal(secondDry.summary.alreadyCorrect, 1);
    assert.equal(secondDry.summary.needsUpdate, 0);
    assert.equal(secondDry.summary.updated, 0);
    assert.equal(secondDry.summary.preflightSafe, true);

    const secondApply = await enrichCatalogPublicationDates(prisma, {
      source: fixtureCsvPath1,
      apply: true,
    });
    assert.equal(secondApply.summary.alreadyCorrect, 1);
    assert.equal(secondApply.summary.needsUpdate, 0);
    assert.equal(secondApply.summary.updated, 0);
    assert.equal(secondApply.summary.preflightSafe, true);

    // 5. Conflicting date blocker: source has different date than existing non-null DB date
    const fixtureCsvConflict = path.join(tempDir, 'source-conflict.csv');
    fs.writeFileSync(
      fixtureCsvConflict,
      `isbn,publicationDate,sourceUrl\n${isbn1},2003-08-15,https://example.com/source2\n`
    );

    const conflictDry = await enrichCatalogPublicationDates(prisma, {
      source: fixtureCsvConflict,
      apply: false,
    });
    assert.equal(conflictDry.summary.preflightSafe, false);
    assert.equal(conflictDry.summary.conflictingExistingDates, 1);

    await assert.rejects(
      () => enrichCatalogPublicationDates(prisma, { source: fixtureCsvConflict, apply: true }),
      PublicationDateEnrichmentError
    );

    // 6. Stale preflight protection: DB publicationDate changed before apply write phase
    const fixtureCsvStale = path.join(tempDir, 'source-stale.csv');
    fs.writeFileSync(
      fixtureCsvStale,
      `isbn,publicationDate,sourceUrl\n${isbn1},2003-05-27,https://example.com/source1\n${isbn2},2003-08-15,https://example.com/source2\n`
    );

    // Reset both books to publicationDate = null
    await prisma.book.update({ where: { id: book1.id }, data: { publicationDate: null } });
    await prisma.book.update({ where: { id: book2.id }, data: { publicationDate: null } });

    // Intercept $transaction to simulate external write modifying book1 before apply writes
    const origTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = async (fn, opts) => {
      // Modify book1 in database concurrently before tx runs
      await prisma.book.update({
        where: { id: book1.id },
        data: { publicationDate: new Date('2003-01-01T00:00:00.000Z') },
      });
      return origTransaction(fn, opts);
    };

    try {
      await assert.rejects(
        () => enrichCatalogPublicationDates(prisma, { source: fixtureCsvStale, apply: true }),
        err => {
          assert.equal(err.code, 'stale_preflight');
          return true;
        }
      );
    } finally {
      prisma.$transaction = origTransaction;
    }

    // Verify book1 was NOT overwritten by the planned date
    const book1StaleCheck = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(
      book1StaleCheck.publicationDate.toISOString().slice(0, 10),
      '2003-01-01',
      'Changed publicationDate was not overwritten'
    );

    // Verify book2 was NOT partially written (remains null)
    const book2StaleCheck = await prisma.book.findUnique({ where: { id: book2.id } });
    assert.equal(book2StaleCheck.publicationDate, null, 'Planned book2 was not partially written');
  }
);
