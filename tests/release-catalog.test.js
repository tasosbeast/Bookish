import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCalendarDate,
  isValidHttpsUrl,
  parseReleaseCatalogCsv,
  validateReleaseCatalogRecords,
  importReleaseCatalog,
  ReleaseCatalogError,
  EXPECTED_HEADERS,
  deriveReleaseProvider,
} from '../scripts/catalog/release-catalog.js';

function createMockDb({ books = [], genres = [], releaseSources = [] } = {}) {
  const defaultGenres = [
    { id: 'g-1', slug: 'fiction', name: 'Fiction' },
    { id: 'g-2', slug: 'romance', name: 'Romance' },
    { id: 'g-3', slug: 'fantasy', name: 'Fantasy' },
    { id: 'g-4', slug: 'science-fiction', name: 'Science Fiction' },
    { id: 'g-5', slug: 'classics', name: 'Classics' },
  ];

  const genreList = genres.length > 0 ? genres : defaultGenres;
  const genreStore = new Map(genreList.map(g => [g.id, { ...g }]));

  const bookStore = new Map();
  const bookGenresStore = []; // array of { bookId, genreId }
  const sourceStore = new Map(releaseSources.map((source, index) => [source.id || `source-${index + 1}`, { ...source, id: source.id || `source-${index + 1}` }]));

  for (const b of books) {
    const bookRecord = {
      id: b.id || `b-${bookStore.size + 1}`,
      title: b.title,
      author: b.author,
      isbn: b.isbn ?? null,
      publicationYear: b.publicationYear ?? null,
      publicationDate: b.publicationDate ? new Date(b.publicationDate) : null,
      coverImageUrl: b.coverImageUrl ?? null,
      description: b.description ?? null,
    };
    bookStore.set(bookRecord.id, bookRecord);

    if (b.genres && Array.isArray(b.genres)) {
      for (const slug of b.genres) {
        const foundGenre = genreList.find(g => g.slug === slug);
        if (foundGenre) {
          bookGenresStore.push({ bookId: bookRecord.id, genreId: foundGenre.id });
        }
      }
    }
  }

  const writes = [];

  function formatBook(b, select) {
    const res = { ...b };
    if (select?.bookGenres) {
      const links = bookGenresStore.filter(bg => bg.bookId === b.id);
      res.bookGenres = links.map(l => {
        const g = genreStore.get(l.genreId);
        return { genre: { slug: g.slug, name: g.name } };
      });
    }
    if (select?.releaseMetadataSource) {
      res.releaseMetadataSource = [...sourceStore.values()].find(source => source.bookId === b.id) || null;
    }
    return res;
  }

  const db = {
    _bookStore: bookStore,
    _bookGenresStore: bookGenresStore,
    _writes: writes,
    _sourceStore: sourceStore,
    book: {
      findMany: async ({ where, select } = {}) => {
        let results = Array.from(bookStore.values());
        if (where?.isbn?.in) {
          results = results.filter(b => where.isbn.in.includes(b.isbn));
        }
        return results.map(b => formatBook(b, select));
      },
    },
    genre: {
      findMany: async ({ where, select } = {}) => {
        let results = Array.from(genreStore.values());
        if (where?.slug?.in) {
          results = results.filter(g => where.slug.in.includes(g.slug));
        }
        return results;
      },
    },
    releaseMetadataSource: {
      findMany: async () => [...sourceStore.values()],
    },
    $transaction: async (fn, opts) => {
      // Snapshot state for rollback
      const snapshotBooks = new Map(Array.from(bookStore.entries()).map(([k, v]) => [k, { ...v }]));
      const snapshotBookGenres = [...bookGenresStore];
      const snapshotSources = new Map([...sourceStore.entries()].map(([key, value]) => [key, { ...value }]));
      const writesBefore = writes.length;

      const tx = {
        book: {
          findMany: async ({ where, select } = {}) => {
            let results = Array.from(bookStore.values());
            if (where?.isbn?.in) {
              results = results.filter(b => where.isbn.in.includes(b.isbn));
            }
            return results.map(b => formatBook(b, select));
          },
          findUnique: async ({ where, select } = {}) => {
            const book = [...bookStore.values()].find(item => item.id === where.id || item.isbn === where.isbn);
            return book ? formatBook(book, select) : null;
          },
          create: async ({ data }) => {
            if (db._simulateUniqueConstraint) {
              const err = new Error('Unique constraint failed on the fields: (`isbn`)');
              err.code = 'P2002';
              throw err;
            }
            const id = `b-${bookStore.size + 1}`;
            const bookRecord = {
              id,
              title: data.title,
              author: data.author,
              isbn: data.isbn,
              publicationDate: data.publicationDate,
              publicationYear: data.publicationYear,
              coverImageUrl: data.coverImageUrl,
              description: data.description ?? null,
            };
            bookStore.set(id, bookRecord);
            writes.push({ type: 'book.create', data: bookRecord });

            if (data.bookGenres?.create) {
              for (const bg of data.bookGenres.create) {
                const link = { bookId: id, genreId: bg.genreId };
                bookGenresStore.push(link);
                writes.push({ type: 'bookGenre.create', data: link });
              }
            }
            return bookRecord;
          },
        },
        releaseMetadataSource: {
          findUnique: async ({ where }) => [...sourceStore.values()].find(source =>
            source.provider === where.provider_sourceIsbn.provider && source.sourceIsbn === where.provider_sourceIsbn.sourceIsbn
          ) || (db._simulateSourceCollision ? { id: 'source-race', bookId: 'other-book' } : null),
          create: async ({ data }) => {
            const id = `source-${sourceStore.size + 1}`;
            const source = { id, ...data };
            sourceStore.set(id, source);
            writes.push({ type: 'releaseMetadataSource.create', data: source });
            return source;
          },
        },
        genre: {
          findMany: async ({ where, select } = {}) => {
            let results = Array.from(genreStore.values());
            if (where?.slug?.in) {
              results = results.filter(g => where.slug.in.includes(g.slug));
            }
            return results;
          },
        },
      };

      try {
        return await fn(tx);
      } catch (err) {
        bookStore.clear();
        for (const [k, v] of snapshotBooks.entries()) {
          bookStore.set(k, v);
        }
        bookGenresStore.length = 0;
        bookGenresStore.push(...snapshotBookGenres);
        sourceStore.clear();
        for (const [key, value] of snapshotSources.entries()) sourceStore.set(key, value);
        writes.length = writesBefore;
        throw err;
      }
    },
  };

  return db;
}

const VALID_HEADER = 'title,author,isbn,publicationDate,coverImageUrl,genres,sourceUrl\n';

test('1. Header-only source is valid', async () => {
  const db = createMockDb();
  const res = await importReleaseCatalog(db, {
    csvContent: VALID_HEADER,
    apply: true,
  });
  assert.equal(res.summary.sourceRows, 0);
  assert.equal(res.summary.validRows, 0);
  assert.equal(res.summary.newBooks, 0);
  assert.equal(res.summary.created, 0);
  assert.equal(res.summary.preflightSafe, true);
  assert.equal(db._writes.length, 0);
});

test('2. Valid row parses correctly', () => {
  const csv = VALID_HEADER + 'The Midnight Library,Matt Haig,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction;fantasy,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 0);
  assert.equal(validRows.length, 1);
  const r = validRows[0];
  assert.equal(r.title, 'The Midnight Library');
  assert.equal(r.author, 'Matt Haig');
  assert.equal(r.isbn, '9780525559474');
  assert.equal(r.publicationDate, '2025-06-15');
  assert.equal(r.derivedYear, 2025);
  assert.equal(r.coverImageUrl, 'https://example.com/cover.jpg');
  assert.deepEqual(r.genres, ['fiction', 'fantasy']);
  assert.equal(r.sourceUrl, 'https://www.penguinrandomhouse.com/source');
});

test('3. Invalid ISBN rejected', () => {
  const csv = VALID_HEADER + 'The Book,Author,9780525559479,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'isbn');
  assert.equal(validRows.length, 0);
});

test('4. Duplicate ISBN rejected within CSV', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER +
    'Book One,Author A,9780525559474,2025-06-15,https://example.com/c1.jpg,fiction,https://www.penguinrandomhouse.com/s1\n' +
    'Book Two,Author B,9780525559474,2025-07-20,https://example.com/c2.jpg,fiction,https://www.penguinrandomhouse.com/s2\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.duplicateIsbns, 1);
  assert.equal(res.summary.preflightSafe, false);
});

test('5. Duplicate normalized work rejected within CSV', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER +
    'The Great Adventure,Jane Doe,9780525559474,2025-06-15,https://example.com/c1.jpg,fiction,https://www.penguinrandomhouse.com/s1\n' +
    'Great Adventure,"Doe, Jane",9780141439518,2025-07-20,https://example.com/c2.jpg,fiction,https://www.penguinrandomhouse.com/s2\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.duplicateWorks, 1);
  assert.equal(res.summary.preflightSafe, false);
});

test('6. Invalid date format rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025/06/15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'publicationDate');
  assert.equal(validRows.length, 0);
});

test('7. Impossible date rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-02-30,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'publicationDate');
  assert.equal(validRows.length, 0);
});

test('8. Date before 2025 rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2024-12-31,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'publicationDate');
  assert.equal(validRows.length, 0);
});

test('9. Date after 2027 rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2028-01-01,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'publicationDate');
  assert.equal(validRows.length, 0);
});

test('10. Non-HTTPS cover rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-06-15,http://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'coverImageUrl');
  assert.equal(validRows.length, 0);
});

test('11. Non-HTTPS sourceUrl rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,ftp://example.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'sourceUrl');
  assert.equal(validRows.length, 0);
});

test('12. 0 genres rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-06-15,https://example.com/cover.jpg,,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'genres');
  assert.equal(validRows.length, 0);
});

test('13. >3 genres rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction;romance;fantasy;classics,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'genres');
  assert.equal(validRows.length, 0);
});

test('14. Duplicate genre rejected', () => {
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction;fiction,https://www.penguinrandomhouse.com/source\n';
  const rawRecords = parseReleaseCatalogCsv(csv);
  const { invalidRows, validRows } = validateReleaseCatalogRecords(rawRecords);
  assert.equal(invalidRows.length, 1);
  assert.equal(invalidRows[0].field, 'genres');
  assert.equal(validRows.length, 0);
});

test('15. Unknown genre blocks preflight', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'Book,Author,9780525559474,2025-06-15,https://example.com/cover.jpg,unknown-genre-slug,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.missingGenres, 1);
  assert.equal(res.summary.preflightSafe, false);
  assert.equal(res.details.missingGenres[0].missingGenreSlugs[0], 'unknown-genre-slug');
});

test('16. Exact existing identical row without provenance = missingProvenance', async () => {
  const db = createMockDb({
    books: [
      {
        id: 'book-1',
        title: 'The Midnight Library',
        author: 'Matt Haig',
        isbn: '9780525559474',
        publicationYear: 2025,
        publicationDate: '2025-06-15',
        coverImageUrl: 'https://example.com/cover.jpg',
        genres: ['fiction', 'fantasy'],
      },
    ],
  });

  const csv = VALID_HEADER + 'The Midnight Library,Matt Haig,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction;fantasy,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.alreadyPresent, 0);
  assert.equal(res.summary.missingProvenance, 1);
  assert.equal(res.summary.newBooks, 0);
  assert.equal(res.summary.exactIsbnConflicts, 0);
  assert.equal(res.summary.preflightSafe, true);
});

test('17. Exact ISBN different metadata = blocker', async () => {
  const db = createMockDb({
    books: [
      {
        id: 'book-1',
        title: 'Original Title',
        author: 'Original Author',
        isbn: '9780525559474',
        publicationYear: 2025,
        publicationDate: '2025-06-15',
        coverImageUrl: 'https://example.com/cover.jpg',
        genres: ['fiction'],
      },
    ],
  });

  const csv = VALID_HEADER + 'Different Title,Different Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.exactIsbnConflicts, 1);
  assert.equal(res.summary.preflightSafe, false);
  assert.equal(res.details.exactIsbnConflicts[0].isbn, '9780525559474');
});

test('18. Same work different ISBN = blocker', async () => {
  const db = createMockDb({
    books: [
      {
        id: 'book-1',
        title: 'The Midnight Library',
        author: 'Matt Haig',
        isbn: '9780525559474',
        publicationYear: 2020,
        publicationDate: '2020-09-29',
        coverImageUrl: 'https://example.com/old-cover.jpg',
        genres: ['fiction'],
      },
    ],
  });

  // Different ISBN, same work identity
  const csv = VALID_HEADER + 'The Midnight Library,Matt Haig,9780141439518,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.existingWorkCollisions, 1);
  assert.equal(res.summary.preflightSafe, false);
});

test('19. Dry-run performs no writes', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'New Release Book,New Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(res.summary.newBooks, 1);
  assert.equal(res.summary.created, 0);
  assert.equal(res.summary.preflightSafe, true);
  assert.equal(db._writes.length, 0);
});

test('20. Apply with blocker performs no writes', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'Bad Date Book,Author,9780525559474,2020-01-01,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  await assert.rejects(
    async () => {
      await importReleaseCatalog(db, { csvContent: csv, apply: true });
    },
    err => {
      assert.equal(err instanceof ReleaseCatalogError, true);
      assert.equal(err.code, 'preflight_blocked');
      return true;
    }
  );
  assert.equal(db._writes.length, 0);
});

test('21. Safe apply creates Book + BookGenre relations', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'New Release Book,New Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction;romance,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: true });
  assert.equal(res.summary.created, 1);
  assert.equal(db._bookStore.size, 1);
  assert.equal(db._bookGenresStore.length, 2);
  const createdBook = Array.from(db._bookStore.values())[0];
  assert.equal(createdBook.isbn, '9780525559474');
  assert.equal(createdBook.title, 'New Release Book');
  assert.equal(createdBook.author, 'New Author');
  const source = [...db._sourceStore.values()][0];
  assert.equal(source.sourceIsbn, createdBook.isbn);
  assert.equal(source.provider, 'prh');
  assert.equal(source.verifiedPublicationDate.toISOString().slice(0, 10), '2025-06-15');
  assert.ok(source.lastVerifiedAt instanceof Date);
});

test('22. publicationYear derived from publicationDate', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'Future Book,Future Author,9780525559474,2026-11-20,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const res = await importReleaseCatalog(db, { csvContent: csv, apply: true });
  assert.equal(res.summary.created, 1);
  const createdBook = Array.from(db._bookStore.values())[0];
  assert.equal(createdBook.publicationYear, 2026);
});

test('23. Second run is idempotent', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'Idempotent Book,Some Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction;romance,https://www.penguinrandomhouse.com/source\n';
  const res1 = await importReleaseCatalog(db, { csvContent: csv, apply: true });
  assert.equal(res1.summary.created, 1);

  const res2 = await importReleaseCatalog(db, { csvContent: csv, apply: true });
  assert.equal(res2.summary.newBooks, 0);
  assert.equal(res2.summary.alreadyPresent, 1);
  assert.equal(res2.summary.created, 0);
  assert.equal(res2.summary.preflightSafe, true);
  assert.equal(db._bookStore.size, 1);
});

test('25. Trusted provider mapping is strict', () => {
  assert.equal(deriveReleaseProvider('https://www.penguinrandomhouse.com/books/one'), 'prh');
  assert.equal(deriveReleaseProvider('https://us.macmillan.com/books/one'), 'macmillan');
  assert.equal(deriveReleaseProvider('https://www.hachettebookgroup.com/books/one'), 'hachette');
  assert.throws(() => deriveReleaseProvider('http://www.penguinrandomhouse.com/books/one'), { code: 'invalid_source_url' });
  assert.throws(() => deriveReleaseProvider('https://example.com/books/one'), { code: 'unsupported_source_provider' });
});

test('26. Apply attaches missing provenance without changing Book metadata', async () => {
  const db = createMockDb({ books: [{ id: 'book-1', title: 'The Midnight Library', author: 'Matt Haig', isbn: '9780525559474', publicationYear: 2025, publicationDate: '2025-06-15', coverImageUrl: 'https://example.com/cover.jpg', genres: ['fiction'] }] });
  const csv = VALID_HEADER + 'The Midnight Library,Matt Haig,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const before = { ...db._bookStore.get('book-1') };
  const result = await importReleaseCatalog(db, { csvContent: csv, apply: true });
  assert.equal(result.summary.provenanceAttached, 1);
  assert.deepEqual(db._bookStore.get('book-1'), before);
  assert.equal(db._sourceStore.size, 1);
});

test('27. Existing conflicting provenance blocks apply', async () => {
  const db = createMockDb({
    books: [{ id: 'book-1', title: 'The Midnight Library', author: 'Matt Haig', isbn: '9780525559474', publicationYear: 2025, publicationDate: '2025-06-15', coverImageUrl: 'https://example.com/cover.jpg', genres: ['fiction'] }],
    releaseSources: [{ bookId: 'book-1', provider: 'macmillan', sourceUrl: 'https://us.macmillan.com/books/one', sourceIsbn: '9780525559474', verifiedPublicationDate: new Date('2025-06-15T00:00:00.000Z') }],
  });
  const csv = VALID_HEADER + 'The Midnight Library,Matt Haig,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const result = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(result.summary.provenanceConflicts, 1);
  assert.equal(result.summary.preflightSafe, false);
});

test('28. Provider/source ISBN collision blocks a different Book', async () => {
  const db = createMockDb({
    books: [{ id: 'other-book', title: 'Other Book', author: 'Other Author', isbn: '9780141439518', genres: [] }],
    releaseSources: [{ bookId: 'other-book', provider: 'prh', sourceUrl: 'https://www.penguinrandomhouse.com/other', sourceIsbn: '9780525559474', verifiedPublicationDate: new Date('2025-01-01T00:00:00.000Z') }],
  });
  const csv = VALID_HEADER + 'New Release,New Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  const result = await importReleaseCatalog(db, { csvContent: csv, apply: false });
  assert.equal(result.summary.provenanceConflicts, 1);
  await assert.rejects(() => importReleaseCatalog(db, { csvContent: csv, apply: true }), err => err.code === 'preflight_blocked');
  assert.equal(db._bookStore.size, 1);
});

test('29. Stale provenance collision rolls back the whole batch', async () => {
  const db = createMockDb();
  db._simulateSourceCollision = true;
  const csv = VALID_HEADER +
    'Release One,Author One,9780525559474,2025-06-15,https://example.com/one.jpg,fiction,https://www.penguinrandomhouse.com/one\n' +
    'Release Two,Author Two,9780141439518,2025-07-15,https://example.com/two.jpg,fiction,https://www.penguinrandomhouse.com/two\n';
  await assert.rejects(() => importReleaseCatalog(db, { csvContent: csv, apply: true }), err => err.code === 'stale_preflight');
  assert.equal(db._bookStore.size, 0);
  assert.equal(db._sourceStore.size, 0);
});

test('24. Stale preflight rolls back whole batch', async () => {
  const db = createMockDb();
  const csv = VALID_HEADER + 'Stale Preflight Book,Author,9780525559474,2025-06-15,https://example.com/cover.jpg,fiction,https://www.penguinrandomhouse.com/source\n';
  db._simulateUniqueConstraint = true;
  await assert.rejects(
    async () => {
      await importReleaseCatalog(db, { csvContent: csv, apply: true });
    },
    err => {
      assert.equal(err instanceof ReleaseCatalogError, true);
      assert.equal(err.code, 'stale_preflight');
      return true;
    }
  );
  assert.equal(db._bookStore.size, 0);
  assert.equal(db._writes.length, 0);
});
