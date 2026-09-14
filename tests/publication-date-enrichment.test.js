import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCalendarDate,
  isValidHttpsUrl,
  parsePublicationDatesCsv,
  enrichCatalogPublicationDates,
  applyConditionalPublicationDateUpdate,
  PublicationDateEnrichmentError,
} from '../scripts/catalog/publication-date-enrichment.js';

function createMockDb(books = []) {
  const store = new Map(books.map(b => [b.id, { ...b }]));
  const updates = [];
  return {
    _store: store,
    _updates: updates,
    book: {
      findMany: async ({ where }) => {
        const isbns = where?.isbn?.in;
        const ids = where?.id?.in;
        return Array.from(store.values()).filter(b => {
          if (isbns) return isbns.includes(b.isbn);
          if (ids) return ids.includes(b.id);
          return true;
        });
      },
      update: async ({ where, data }) => {
        const book = store.get(where.id);
        if (!book) throw new Error('Not found');
        Object.assign(book, data);
        updates.push({ id: where.id, data });
        return book;
      },
    },
    $transaction: async fn => {
      const rollbackMap = new Map();
      const updatesBefore = updates.length;
      const tx = {
        book: {
          update: async ({ where, data }) => {
            const book = store.get(where.id);
            if (!book) throw new Error('Not found');
            if (!rollbackMap.has(book.id)) {
              rollbackMap.set(book.id, { ...book });
            }
            Object.assign(book, data);
            updates.push({ id: where.id, data });
            return book;
          },
          updateMany: async ({ where, data }) => {
            let count = 0;
            for (const book of store.values()) {
              if (where.id !== undefined && book.id !== where.id) continue;
              if (where.isbn !== undefined && book.isbn !== where.isbn) continue;
              if (where.publicationDate === null && (book.publicationDate !== null && book.publicationDate !== undefined)) continue;
              if (where.OR) {
                const match = where.OR.some(clause => {
                  if (clause.publicationYear === null) {
                    return book.publicationYear === null || book.publicationYear === undefined;
                  }
                  if (clause.publicationYear !== undefined) {
                    return book.publicationYear === clause.publicationYear;
                  }
                  return false;
                });
                if (!match) continue;
              }
              if (!rollbackMap.has(book.id)) {
                rollbackMap.set(book.id, { ...book });
              }
              Object.assign(book, data);
              updates.push({ id: book.id, data });
              count++;
            }
            return { count };
          },
          findMany: async ({ where }) => {
            const ids = where?.id?.in;
            return Array.from(store.values()).filter(b => ids.includes(b.id));
          },
        },
      };

      try {
        return await fn(tx);
      } catch (err) {
        for (const [id, originalBookState] of rollbackMap.entries()) {
          store.set(id, originalBookState);
        }
        updates.length = updatesBefore;
        throw err;
      }
    },
  };
}

const canonicalIsbns = new Set([
  '9780141439518',
  '9780141439556',
  '9780141441146',
  '9780141439600',
  '9780743273565',
]);

test('1. empty/header-only source is valid and produces zero work', async () => {
  const db = createMockDb();
  // completely empty string
  const res1 = await enrichCatalogPublicationDates(db, { csvContent: '', canonicalIsbns });
  assert.equal(res1.summary.sourceRows, 0);
  assert.equal(res1.summary.preflightSafe, true);
  assert.equal(res1.summary.updated, 0);

  // header only
  const res2 = await enrichCatalogPublicationDates(db, {
    csvContent: 'isbn,publicationDate,sourceUrl\n',
    canonicalIsbns,
  });
  assert.equal(res2.summary.sourceRows, 0);
  assert.equal(res2.summary.preflightSafe, true);
  assert.equal(res2.summary.updated, 0);
});

test('2. strict valid YYYY-MM-DD', () => {
  assert.equal(isValidCalendarDate('2026-09-22'), true);
  assert.equal(isValidCalendarDate('2024-02-29'), true); // leap year
  assert.equal(isValidCalendarDate('1999-12-31'), true);
});

test('3. invalid date format rejected', () => {
  assert.equal(isValidCalendarDate('2026/09/22'), false);
  assert.equal(isValidCalendarDate('09-22-2026'), false);
  assert.equal(isValidCalendarDate('2026-9-22'), false);
  assert.equal(isValidCalendarDate('2026-09-22T00:00:00.000Z'), false);
  assert.equal(isValidCalendarDate('not-a-date'), false);
  assert.equal(isValidCalendarDate(''), false);
});

test('4. impossible date rejected', () => {
  assert.equal(isValidCalendarDate('2026-02-30'), false);
  assert.equal(isValidCalendarDate('2025-02-29'), false); // non-leap year
  assert.equal(isValidCalendarDate('2026-04-31'), false);
  assert.equal(isValidCalendarDate('2026-13-01'), false);
  assert.equal(isValidCalendarDate('2026-00-10'), false);
});

test('5. duplicate ISBN rejected', async () => {
  const db = createMockDb();
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source1
9780141439518,2026-09-22,https://example.com/source2`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, false);
  assert.ok(res.details.validationErrors.some(e => e.message.includes('Duplicate ISBN')));
});

test('6. invalid ISBN rejected', async () => {
  const db = createMockDb();
  const csv = `isbn,publicationDate,sourceUrl
9780141439519,2026-09-22,https://example.com/source`; // bad checksum

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, false);
  assert.ok(res.details.validationErrors.some(e => e.message.includes('Invalid ISBN-13')));
});

test('7. non-HTTPS sourceUrl rejected', async () => {
  const db = createMockDb();
  assert.equal(isValidHttpsUrl('https://example.com/valid'), true);
  assert.equal(isValidHttpsUrl('http://insecure.com'), false);
  assert.equal(isValidHttpsUrl('ftp://example.com'), false);
  assert.equal(isValidHttpsUrl('not-a-url'), false);

  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,http://insecure.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, false);
  assert.ok(res.details.validationErrors.some(e => e.message.includes('Must be a valid HTTPS URL')));
});

test('8. ISBN not in canonical catalog rejected', async () => {
  const db = createMockDb();
  // Valid ISBN-13 but not in our canonicalIsbns set
  const nonCanonicalIsbn = '9780345391803'; // Hitchhiker's Guide
  const csv = `isbn,publicationDate,sourceUrl
${nonCanonicalIsbn},2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, false);
  assert.ok(res.details.validationErrors.some(e => e.message.includes('does not exist in canonical catalog')));
});

test('9. exact ISBN match only', async () => {
  const db = createMockDb([
    {
      id: 'book-different-isbn',
      isbn: '9780141439556',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      publicationYear: 2026,
      publicationDate: null,
    },
  ]);
  // Query for 9780141439518 (which is Pride and Prejudice's real ISBN, but DB has 9780141439556)
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.matchedDatabaseBooks, 0);
  assert.equal(res.summary.missingDatabaseBooks, 1);
  assert.equal(res.summary.preflightSafe, false);
});

test('10. null publicationDate -> needsUpdate', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2026,
      publicationDate: null,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, true);
  assert.equal(res.summary.needsUpdate, 1);
  assert.equal(res.summary.alreadyCorrect, 0);
  assert.equal(res.details.needsUpdate[0].publicationDate, '2026-09-22');
});

test('11. same date -> alreadyCorrect', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2026,
      publicationDate: new Date('2026-09-22T00:00:00.000Z'),
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, true);
  assert.equal(res.summary.alreadyCorrect, 1);
  assert.equal(res.summary.needsUpdate, 0);
});

test('12. different non-null date -> blocker', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2026,
      publicationDate: new Date('2026-09-01T00:00:00.000Z'),
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, false);
  assert.equal(res.summary.conflictingExistingDates, 1);
  assert.equal(res.details.conflictingExistingDates[0].databaseDate, '2026-09-01');
});

test('13. publicationYear mismatch -> blocker', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2025,
      publicationDate: null,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, false);
  assert.equal(res.summary.publicationYearMismatches, 1);
  assert.equal(res.details.publicationYearMismatches[0].databaseYear, 2025);
  assert.equal(res.details.publicationYearMismatches[0].requestedYear, 2026);
});

test('14. null publicationYear is allowed', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: null,
      publicationDate: null,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns });
  assert.equal(res.summary.preflightSafe, true);
  assert.equal(res.summary.publicationYearMismatches, 0);
  assert.equal(res.summary.needsUpdate, 1);
});

test('15. dry-run writes nothing', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2026,
      publicationDate: null,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: false });
  assert.equal(res.summary.updated, 0);
  assert.equal(db._updates.length, 0);
  assert.equal(db._store.get('book-1').publicationDate, null);
});

test('16. apply with any blocker writes nothing', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2025, // mismatch
      publicationDate: null,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  await assert.rejects(
    () => enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: true }),
    PublicationDateEnrichmentError
  );
  assert.equal(db._updates.length, 0);
  assert.equal(db._store.get('book-1').publicationDate, null);
});

test('17. successful apply updates ONLY publicationDate', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      publicationYear: 2026,
      publicationDate: null,
      description: 'Classic novel',
      coverImageUrl: 'https://example.com/cover.jpg',
      averageRating: 4.5,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  const res = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: true });
  assert.equal(res.summary.updated, 1);
  assert.equal(db._updates.length, 1);

  const updatedBook = db._store.get('book-1');
  assert.equal(updatedBook.publicationDate.toISOString().slice(0, 10), '2026-09-22');
  // Confirm other fields untouched
  assert.equal(updatedBook.title, 'Pride and Prejudice');
  assert.equal(updatedBook.author, 'Jane Austen');
  assert.equal(updatedBook.isbn, '9780141439518');
  assert.equal(updatedBook.publicationYear, 2026);
  assert.equal(updatedBook.description, 'Classic novel');
  assert.equal(updatedBook.coverImageUrl, 'https://example.com/cover.jpg');
  assert.equal(updatedBook.averageRating, 4.5);
});

test('18. second run is idempotent', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2026,
      publicationDate: null,
    },
  ]);
  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2026-09-22,https://example.com/source`;

  // First dry-run
  const dry1 = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: false });
  assert.equal(dry1.summary.needsUpdate, 1);
  assert.equal(dry1.summary.alreadyCorrect, 0);

  // First apply
  const apply1 = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: true });
  assert.equal(apply1.summary.updated, 1);

  // Second dry-run
  const dry2 = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: false });
  assert.equal(dry2.summary.alreadyCorrect, 1);
  assert.equal(dry2.summary.needsUpdate, 0);

  // Second apply
  const apply2 = await enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: true });
  assert.equal(apply2.summary.alreadyCorrect, 1);
  assert.equal(apply2.summary.needsUpdate, 0);
  assert.equal(apply2.summary.updated, 0);
});

test('19. stale preflight: publicationDate modified before apply throws stale_preflight and writes nothing', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2003,
      publicationDate: null,
    },
    {
      id: 'book-2',
      isbn: '9780141439556',
      title: 'Wuthering Heights',
      publicationYear: 2003,
      publicationDate: null,
    },
  ]);

  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2003-05-27,https://example.com/source1
9780141439556,2003-08-15,https://example.com/source2`;

  // Intercept inside transaction to simulate external modification before apply writes
  const originalTx = db.$transaction;
  db.$transaction = async fn => {
    // Modify book-1 in store before fn runs
    db._store.get('book-1').publicationDate = new Date('2003-01-01T00:00:00.000Z');
    return originalTx(fn);
  };

  await assert.rejects(
    () => enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: true }),
    err => {
      assert.equal(err.name, 'PublicationDateEnrichmentError');
      assert.equal(err.code, 'stale_preflight');
      assert.match(err.message, /publicationDate was modified/);
      return true;
    }
  );

  // Assert nothing was written by apply
  assert.equal(db._updates.length, 0);
  // Book 1 still has the intervening date, not the requested date
  assert.equal(db._store.get('book-1').publicationDate.toISOString().slice(0, 10), '2003-01-01');
  // Book 2 was NOT partially written
  assert.equal(db._store.get('book-2').publicationDate, null);
});

test('20. applyConditionalPublicationDateUpdate helper performs conditional update and enforces count === 1', async () => {
  const store = new Map([
    ['book-1', { id: 'book-1', isbn: '9780141439518', publicationYear: 2003, publicationDate: null }],
    ['book-2', { id: 'book-2', isbn: '9780141439556', publicationYear: 2003, publicationDate: new Date('2003-01-01T00:00:00.000Z') }],
    ['book-3', { id: 'book-3', isbn: '9780141441146', publicationYear: 2005, publicationDate: null }],
  ]);

  const mockTx = {
    book: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const book of store.values()) {
          if (where.id !== undefined && book.id !== where.id) continue;
          if (where.isbn !== undefined && book.isbn !== where.isbn) continue;
          if (where.publicationDate === null && book.publicationDate !== null) continue;
          if (where.OR) {
            const match = where.OR.some(c => {
              if (c.publicationYear === null) return book.publicationYear === null;
              if (c.publicationYear !== undefined) return book.publicationYear === c.publicationYear;
              return false;
            });
            if (!match) continue;
          }
          Object.assign(book, data);
          count++;
        }
        return { count };
      },
    },
  };

  // Valid update
  const res = await applyConditionalPublicationDateUpdate(mockTx, {
    bookId: 'book-1',
    isbn: '9780141439518',
    publicationDate: '2003-05-27',
  });
  assert.equal(res.count, 1);
  assert.equal(store.get('book-1').publicationDate.toISOString().slice(0, 10), '2003-05-27');

  // Stale because publicationDate is non-null
  await assert.rejects(
    () => applyConditionalPublicationDateUpdate(mockTx, {
      bookId: 'book-2',
      isbn: '9780141439556',
      publicationDate: '2003-08-15',
    }),
    err => {
      assert.equal(err.name, 'PublicationDateEnrichmentError');
      assert.equal(err.code, 'stale_preflight');
      assert.equal(err.details.affectedCount, 0);
      return true;
    }
  );

  // Stale because publicationYear mismatches requested date year (2003 vs 2005)
  await assert.rejects(
    () => applyConditionalPublicationDateUpdate(mockTx, {
      bookId: 'book-3',
      isbn: '9780141441146',
      publicationDate: '2003-10-10',
    }),
    err => {
      assert.equal(err.name, 'PublicationDateEnrichmentError');
      assert.equal(err.code, 'stale_preflight');
      assert.equal(err.details.affectedCount, 0);
      return true;
    }
  );
});

test('21. TOCTOU race: publicationDate changes AFTER revalidation causes conditional update to affect 0 rows, rollback earlier writes', async () => {
  const db = createMockDb([
    {
      id: 'book-1',
      isbn: '9780141439518',
      title: 'Pride and Prejudice',
      publicationYear: 2003,
      publicationDate: null,
    },
    {
      id: 'book-2',
      isbn: '9780141439556',
      title: 'Wuthering Heights',
      publicationYear: 2003,
      publicationDate: null,
    },
  ]);

  const csv = `isbn,publicationDate,sourceUrl
9780141439518,2003-05-27,https://example.com/source1
9780141439556,2003-08-15,https://example.com/source2`;

  let revalidationHappened = false;
  let book2ModifiedDuringRace = false;

  const originalTx = db.$transaction;
  db.$transaction = async fn => {
    return originalTx(async tx => {
      const origFindMany = tx.book.findMany;
      tx.book.findMany = async args => {
        const result = await origFindMany(args);
        // Mark that in-transaction revalidation completed and saw both books valid
        if (args.where?.id?.in?.length === 2) {
          revalidationHappened = true;
        }
        return result;
      };

      const origUpdateMany = tx.book.updateMany;
      let updateManyCallCount = 0;
      tx.book.updateMany = async args => {
        updateManyCallCount++;
        if (updateManyCallCount === 2) {
          // Revalidation already completed and saw both rows as null!
          assert.equal(revalidationHappened, true, 'Revalidation saw both as valid prior to write phase');
          // Simulate race condition AFTER revalidation: another transaction commits an update on book-2
          db._store.get('book-2').publicationDate = new Date('2003-09-01T00:00:00.000Z');
          book2ModifiedDuringRace = true;
        }
        return origUpdateMany(args);
      };

      return fn(tx);
    });
  };

  await assert.rejects(
    () => enrichCatalogPublicationDates(db, { csvContent: csv, canonicalIsbns, apply: true }),
    err => {
      assert.equal(err.name, 'PublicationDateEnrichmentError');
      assert.equal(err.code, 'stale_preflight');
      assert.equal(err.details.affectedCount, 0);
      assert.match(err.message, /conditional update affected 0 rows/);
      return true;
    }
  );

  assert.equal(revalidationHappened, true);
  assert.equal(book2ModifiedDuringRace, true);
  // Earlier update to book-1 must be rolled back
  assert.equal(db._store.get('book-1').publicationDate, null, 'Earlier update to book-1 rolled back');
  // Book 2 must retain the concurrent intervening value (not overwritten)
  assert.equal(
    db._store.get('book-2').publicationDate.toISOString().slice(0, 10),
    '2003-09-01',
    'Intervening publicationDate on book-2 was not overwritten'
  );
  // Updates recorded in transaction must be rolled back
  assert.equal(db._updates.length, 0);
});

