import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCatalogCsv,
  classifyCsvCatalog,
  importCatalogCsv,
  CsvCatalogError,
  coverImageUrl,
} from '../scripts/catalog/csv-import.js';

function mockDatabase(rows = []) {
  const books = new Map(rows.map(row => [row.isbn, structuredClone(row)]));
  const select = (row, fields) =>
    Object.fromEntries(Object.keys(fields).filter(key => fields[key]).map(key => [key, row[key]]));
  const tx = {
    book: {
      createMany: async ({ data }) => {
        for (const item of data) {
          if (books.has(item.isbn)) {
            const err = new Error(`Unique constraint failed on the fields: (isbn)`);
            err.code = 'P2002';
            throw err;
          }
          const row = { id: `book-${books.size + 1}`, averageRating: null, ratingsCount: 0, ...item };
          books.set(row.isbn, row);
        }
        return { count: data.length };
      },
    },
  };
  return {
    book: {
      findMany: async ({ select: fields }) => [...books.values()].map(row => select(row, fields)),
    },
    $transaction: async work => work(tx),
    rows: books,
  };
}

test('1. valid CSV rows parse correctly', () => {
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935\nDune,Frank Herbert,9780441172719`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.sourceRows, 2);
  assert.equal(result.validRows.length, 2);
  assert.equal(result.invalidRows.length, 0);
  assert.equal(result.duplicateIsbns.length, 0);
  assert.equal(result.duplicateWorks.length, 0);
  assert.equal(result.validRows[0].title, '1984');
  assert.equal(result.validRows[0].author, 'George Orwell');
  assert.equal(result.validRows[0].isbn, '9780451524935');
});

test('2. quoted title containing comma parses correctly', () => {
  const csv = `title,author,isbn\n"The Great, Great Gatsby",F. Scott Fitzgerald,9780743273565`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].title, 'The Great, Great Gatsby');
  assert.equal(result.validRows[0].author, 'F. Scott Fitzgerald');
  assert.equal(result.validRows[0].isbn, '9780743273565');
});

test('3. BOM is accepted', () => {
  const csv = `\uFEFFtitle,author,isbn\n1984,George Orwell,9780451524935`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].isbn, '9780451524935');
});

test('4. whitespace is trimmed', () => {
  const csv = `title,author,isbn\n  1984  ,  George Orwell  ,  9780451524935  `;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].title, '1984');
  assert.equal(result.validRows[0].author, 'George Orwell');
  assert.equal(result.validRows[0].isbn, '9780451524935');
});

test('5. hyphenated/spaced ISBN normalizes', () => {
  const csv = `title,author,isbn\n1984,George Orwell,978-0-451-52493-5`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].isbn, '9780451524935');
});

test('6. invalid ISBN checksum is rejected', () => {
  const csv = `title,author,isbn\n1984,George Orwell,9780451524930`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 0);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, 'invalid_isbn');
  assert.equal(result.invalidRows[0].line, 2);
});

test('7. missing title rejected', () => {
  const csv = `title,author,isbn\n,George Orwell,9780451524935`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 0);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, 'missing_title');
  assert.equal(result.invalidRows[0].line, 2);
});

test('8. missing author rejected', () => {
  const csv = `title,author,isbn\n1984,,9780451524935`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 0);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, 'missing_author');
  assert.equal(result.invalidRows[0].line, 2);
});

test('9. missing ISBN rejected', () => {
  const csv = `title,author,isbn\n1984,George Orwell,`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.validRows.length, 0);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, 'missing_isbn');
  assert.equal(result.invalidRows[0].line, 2);
});

test('10. duplicate ISBN inside CSV detected', () => {
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935\nNineteen Eighty-Four,Orwell,9780451524935`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.sourceRows, 2);
  assert.equal(result.validRows.length, 2);
  assert.equal(result.duplicateIsbns.length, 1);
  assert.equal(result.duplicateIsbns[0].isbn, '9780451524935');
  assert.equal(result.duplicateIsbns[0].line, 3);
  assert.equal(result.duplicateIsbns[0].firstSeenLine, 2);
});

test('11. duplicate normalized work inside CSV detected', () => {
  const csv = `title,author,isbn\nThe Hobbit,J.R.R. Tolkien,9780547928227\nThe Hobbit (Illustrated Edition),J.R.R. Tolkien,9780007525546`;
  const result = parseCatalogCsv(csv);
  assert.equal(result.sourceRows, 2);
  assert.equal(result.validRows.length, 2);
  assert.equal(result.duplicateWorks.length, 1);
  assert.equal(result.duplicateWorks[0].line, 3);
  assert.equal(result.duplicateWorks[0].firstSeenLine, 2);
});

test('12. exact DB ISBN match skipped', async () => {
  const db = mockDatabase([
    { id: 'b-1', isbn: '9780451524935', title: '1984', author: 'George Orwell' },
  ]);
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935`;
  const { summary } = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(summary.sourceRows, 1);
  assert.equal(summary.matchedExactIsbn, 1);
  assert.equal(summary.matchedExistingWork, 0);
  assert.equal(summary.newBooks, 0);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 0);
});

test('13. existing normalized work match skipped', async () => {
  const db = mockDatabase([
    { id: 'b-2', isbn: '9780000000001', title: 'The Hobbit', author: 'J.R.R. Tolkien' },
  ]);
  const csv = `title,author,isbn\nThe Hobbit,J.R.R. Tolkien,9780547928227`;
  const { summary } = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(summary.sourceRows, 1);
  assert.equal(summary.matchedExactIsbn, 0);
  assert.equal(summary.matchedExistingWork, 1);
  assert.equal(summary.newBooks, 0);
  assert.equal(summary.conflicts, 0);
});

test('14. existing ISBN with incompatible title/author => conflict', async () => {
  const db = mockDatabase([
    { id: 'b-1', isbn: '9780451524935', title: '1984', author: 'George Orwell' },
  ]);
  const csv = `title,author,isbn\nAnimal Farm,George Orwell,9780451524935`;
  const { summary, details } = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.newBooks, 0);
  assert.equal(details.conflicts[0].reason, 'identity_conflict');
});

test('15. multiple DB work matches => conflict', async () => {
  const db = mockDatabase([
    { id: 'b-1', isbn: '9780441172719', title: 'Dune', author: 'Frank Herbert' },
    { id: 'b-2', isbn: '9780441013593', title: 'Dune (Deluxe Edition)', author: 'Frank Herbert' },
  ]);
  const csv = `title,author,isbn\nDune,Frank Herbert,9780593099322`;
  const { summary, details } = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.newBooks, 0);
  assert.equal(details.conflicts[0].reason, 'ambiguous_work_match');
});

test('16. clean NEW row classified as new', async () => {
  const db = mockDatabase([]);
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935`;
  const { summary } = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(summary.sourceRows, 1);
  assert.equal(summary.validRows, 1);
  assert.equal(summary.newBooks, 1);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.created, 0);
});

test('17. dry-run performs no creates/updates', async () => {
  const db = mockDatabase([
    { id: 'b-existing', isbn: '9780451524935', title: '1984', author: 'George Orwell', averageRating: 4.8 },
  ]);
  const initialCount = db.rows.size;
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935\nDune,Frank Herbert,9780441172719`;
  const { summary } = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 0);
  assert.equal(db.rows.size, initialCount);
  assert.equal(db.rows.get('9780451524935').averageRating, 4.8);
});

test('18. dirty APPLY creates nothing and throws CsvCatalogError', async () => {
  const db = mockDatabase([]);
  // CSV has 1 valid new book and 1 invalid row
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935\nBad Book,Bad Author,9780000000000`;
  await assert.rejects(
    async () => {
      await importCatalogCsv(db, csv, { apply: true });
    },
    err => {
      assert(err instanceof CsvCatalogError);
      assert.equal(err.code, 'preflight_failed');
      assert.equal(err.details.summary.invalidRows, 1);
      return true;
    }
  );
  assert.equal(db.rows.size, 0, 'No books should have been created');
});

test('19. clean APPLY creates only NEW rows', async () => {
  const existingBook = {
    id: 'existing-id-1',
    isbn: '9780451524935',
    title: '1984',
    author: 'George Orwell',
    averageRating: 4.5,
    ratingsCount: 10,
  };
  const db = mockDatabase([existingBook]);
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935\nDune,Frank Herbert,9780441172719`;
  const { summary } = await importCatalogCsv(db, csv, { apply: true });
  assert.equal(summary.sourceRows, 2);
  assert.equal(summary.matchedExactIsbn, 1);
  assert.equal(summary.newBooks, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 0);

  const createdDune = db.rows.get('9780441172719');
  assert.ok(createdDune);
  assert.equal(createdDune.title, 'Dune');
  assert.equal(createdDune.author, 'Frank Herbert');
  assert.equal(createdDune.description, null);
  assert.equal(createdDune.publicationYear, null);
  assert.equal(createdDune.coverImageUrl, coverImageUrl('9780441172719'));
});

test('20. existing Book IDs and fields remain unchanged', async () => {
  const existingBook = {
    id: 'original-uuid-123',
    isbn: '9780451524935',
    title: '1984',
    author: 'George Orwell',
    description: 'Original description',
    publicationYear: 1949,
    coverImageUrl: 'https://example.com/original-cover.jpg',
    averageRating: 4.75,
    ratingsCount: 42,
  };
  const db = mockDatabase([existingBook]);
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935`;
  await importCatalogCsv(db, csv, { apply: true });

  const bookAfter = db.rows.get('9780451524935');
  assert.deepEqual(bookAfter, existingBook);
});

test('22. second run is idempotent', async () => {
  const db = mockDatabase([]);
  const csv = `title,author,isbn\n1984,George Orwell,9780451524935\nDune,Frank Herbert,9780441172719`;
  const run1 = await importCatalogCsv(db, csv, { apply: true });
  assert.equal(run1.summary.created, 1 + 1);

  const run2Dry = await importCatalogCsv(db, csv, { apply: false });
  assert.equal(run2Dry.summary.matchedExactIsbn, 2);
  assert.equal(run2Dry.summary.newBooks, 0);
  assert.equal(run2Dry.summary.created, 0);

  const run2Apply = await importCatalogCsv(db, csv, { apply: true });
  assert.equal(run2Apply.summary.matchedExactIsbn, 2);
  assert.equal(run2Apply.summary.newBooks, 0);
  assert.equal(run2Apply.summary.created, 0);
  assert.equal(db.rows.size, 2);
});
