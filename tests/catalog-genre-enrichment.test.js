import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCSV,
  loadSourceFiles,
  analyzeGenreEnrichment,
  enrichCatalogGenres,
  GenreEnrichmentError,
} from '../scripts/catalog/genre-enrichment.js';

function createMockDb(initialState = {}) {
  const books = (initialState.books || []).map(b => ({ ...b }));
  const genres = (initialState.genres || []).map(g => ({ ...g }));
  // bookGenres: array of { bookId, genreId }
  let bookGenres = (initialState.bookGenres || []).map(bg => ({ ...bg }));

  const writes = {
    genreCreateMany: [],
    bookGenreCreateMany: [],
    bookGenreDeleteMany: [],
    transactions: 0,
  };

  const db = {
    _writes: writes,
    _state: { books, genres, get bookGenres() { return bookGenres; } },
    book: {
      async findMany({ select } = {}) {
        return books.map(b => {
          if (!select) return { ...b };
          const res = {};
          for (const k of Object.keys(select)) res[k] = b[k];
          return res;
        });
      },
    },
    genre: {
      async findMany({ select, where } = {}) {
        let list = genres;
        if (where?.slug?.in) {
          const set = new Set(where.slug.in);
          list = list.filter(g => set.has(g.slug));
        }
        return list.map(g => {
          if (!select) return { ...g };
          const res = {};
          for (const k of Object.keys(select)) res[k] = g[k];
          return res;
        });
      },
      async createMany({ data }) {
        writes.genreCreateMany.push(data);
        for (const item of data) {
          if (!genres.some(g => g.slug === item.slug)) {
            genres.push({ id: `gen-${genres.length + 1}`, ...item });
          }
        }
        return { count: data.length };
      },
    },
    bookGenre: {
      async findMany({ where, include, select } = {}) {
        let list = bookGenres;
        if (where?.bookId?.in) {
          const set = new Set(where.bookId.in);
          list = list.filter(bg => set.has(bg.bookId));
        }
        return list.map(bg => {
          const res = { bookId: bg.bookId, genreId: bg.genreId };
          if (include?.genre || select?.genre) {
            const g = genres.find(x => x.id === bg.genreId);
            res.genre = g ? { id: g.id, slug: g.slug, name: g.name } : null;
          }
          return res;
        });
      },
      async createMany({ data }) {
        writes.bookGenreCreateMany.push(data);
        for (const item of data) {
          if (!bookGenres.some(bg => bg.bookId === item.bookId && bg.genreId === item.genreId)) {
            bookGenres.push({ ...item });
          }
        }
        return { count: data.length };
      },
      async deleteMany({ where } = {}) {
        writes.bookGenreDeleteMany.push(where);
        if (where?.OR) {
          const toDelete = new Set(where.OR.map(p => `${p.bookId}:${p.genreId}`));
          bookGenres = bookGenres.filter(bg => !toDelete.has(`${bg.bookId}:${bg.genreId}`));
        }
        return { count: 1 };
      },
    },
    async $transaction(fn) {
      writes.transactions++;
      return fn(db);
    },
  };

  return db;
}

test('Genre Enrichment Importer: Unit Tests', async t => {
  const source = loadSourceFiles();

  await t.test('1. Taxonomy parsing and validation against real files', () => {
    assert.equal(source.taxonomy.length, 37);
    const slugs = new Set(source.taxonomy.map(t => t.slug));
    assert.equal(slugs.size, 37);
    for (const t of source.taxonomy) {
      assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.slug), `Invalid slug ${t.slug}`);
      assert.ok(t.name.trim().length > 0);
    }
  });

  await t.test('2. Genre mapping validation against real files', () => {
    assert.equal(source.catalogBooks.length, 1002);
    assert.equal(source.genresByIsbn.size, 1002);
    const taxSlugs = new Set(source.taxonomy.map(t => t.slug));

    for (const [isbn, genres] of source.genresByIsbn.entries()) {
      assert.ok(genres.length >= 1 && genres.length <= 3);
      const unique = new Set(genres);
      assert.equal(unique.size, genres.length);
      for (const g of genres) {
        assert.ok(taxSlugs.has(g), `Slug ${g} not in taxonomy for ${isbn}`);
      }
    }
  });

  await t.test('3. Exact ISBN match and normalized work fallback', async () => {
    // 2 synthetic catalog books
    const catalogBooks = [
      { title: 'The Hobbit', author: 'J. R. R. Tolkien', isbn: '9780547928227' },
      { title: 'Dune', author: 'Frank Herbert', isbn: '9780441172719' },
    ];
    const genresByIsbn = new Map([
      ['9780547928227', ['fantasy', 'adventure']],
      ['9780441172719', ['science-fiction']],
    ]);
    const taxonomy = [
      { name: 'Fantasy', slug: 'fantasy' },
      { name: 'Adventure', slug: 'adventure' },
      { name: 'Science Fiction', slug: 'science-fiction' },
    ];

    // DB has book 1 by exact ISBN, book 2 by alternate ISBN but identical normalized work
    const db = createMockDb({
      books: [
        { id: 'b-1', isbn: '9780547928227', title: 'The Hobbit', author: 'J. R. R. Tolkien' },
        { id: 'b-2', isbn: '9780441172700', title: 'Dune', author: 'Frank Herbert' }, // alternate edition
      ],
      genres: [
        { id: 'g-1', name: 'Fantasy', slug: 'fantasy' },
        { id: 'g-2', name: 'Adventure', slug: 'adventure' },
        { id: 'g-3', name: 'Science Fiction', slug: 'science-fiction' },
      ],
    });

    const { summary, details } = await analyzeGenreEnrichment(db, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(summary.sourceBooks, 2);
    assert.equal(summary.matchedExactIsbn, 1);
    assert.equal(summary.matchedExistingWork, 1);
    assert.equal(summary.missingBooks, 0);
    assert.equal(summary.ambiguousBooks, 0);
    assert.equal(details.preflightSafe, true);
  });

  await t.test('4. Missing book blocks apply', async () => {
    const catalogBooks = [
      { title: 'Unknown Book', author: 'Unknown Author', isbn: '9789999999999' },
    ];
    const genresByIsbn = new Map([['9789999999999', ['fiction']]]);
    const taxonomy = [{ name: 'Fiction', slug: 'fiction' }];

    const db = createMockDb({ books: [], genres: [{ id: 'g-1', name: 'Fiction', slug: 'fiction' }] });

    const { summary, details } = await analyzeGenreEnrichment(db, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(summary.missingBooks, 1);
    assert.equal(details.preflightSafe, false);

    await assert.rejects(
      () => enrichCatalogGenres(db, { apply: true, sourceData: { taxonomy, catalogBooks, genresByIsbn } }),
      /Cannot apply: preflight blockers detected/
    );
    assert.equal(db._writes.transactions, 0);
  });

  await t.test('5. Ambiguous work match blocks apply', async () => {
    const catalogBooks = [
      { title: 'Pride and Prejudice', author: 'Jane Austen', isbn: '9780141439518' },
    ];
    const genresByIsbn = new Map([['9780141439518', ['classics', 'romance']]]);
    const taxonomy = [
      { name: 'Classics', slug: 'classics' },
      { name: 'Romance', slug: 'romance' },
    ];

    // DB has 2 alternate editions of Pride and Prejudice, neither matching the catalog ISBN
    const db = createMockDb({
      books: [
        { id: 'b-1', isbn: '9780000000001', title: 'Pride and Prejudice', author: 'Jane Austen' },
        { id: 'b-2', isbn: '9780000000002', title: 'Pride and Prejudice', author: 'Jane Austen' },
      ],
      genres: [
        { id: 'g-1', name: 'Classics', slug: 'classics' },
        { id: 'g-2', name: 'Romance', slug: 'romance' },
      ],
    });

    const { summary, details } = await analyzeGenreEnrichment(db, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(summary.ambiguousBooks, 1);
    assert.equal(details.preflightSafe, false);

    await assert.rejects(
      () => enrichCatalogGenres(db, { apply: true, sourceData: { taxonomy, catalogBooks, genresByIsbn } }),
      /Cannot apply: preflight blockers detected/
    );
    assert.equal(db._writes.transactions, 0);
  });

  await t.test('6. Duplicate production Book claim blocks apply', async () => {
    const catalogBooks = [
      { title: 'War and Peace', author: 'Leo Tolstoy', isbn: '9780140447934' },
      { title: 'War and Peace (Vintage)', author: 'Leo Tolstoy', isbn: '9781400079988' },
    ];
    const genresByIsbn = new Map([
      ['9780140447934', ['classics']],
      ['9781400079988', ['classics']],
    ]);
    const taxonomy = [{ name: 'Classics', slug: 'classics' }];

    // Both catalog rows resolve to the single book in DB
    const db = createMockDb({
      books: [
        { id: 'b-1', isbn: '9780140447934', title: 'War and Peace', author: 'Leo Tolstoy' },
      ],
      genres: [{ id: 'g-1', name: 'Classics', slug: 'classics' }],
    });

    const { summary, details } = await analyzeGenreEnrichment(db, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(summary.bookConflicts, 1);
    assert.equal(details.preflightSafe, false);

    await assert.rejects(
      () => enrichCatalogGenres(db, { apply: true, sourceData: { taxonomy, catalogBooks, genresByIsbn } }),
      /Cannot apply: preflight blockers detected/
    );
  });

  await t.test('7. Genre name and slug conflict detection', async () => {
    const catalogBooks = [{ title: 'Book A', author: 'Author A', isbn: '9780000000001' }];
    const genresByIsbn = new Map([['9780000000001', ['science-fiction']]]);
    const taxonomy = [{ name: 'Science Fiction', slug: 'science-fiction' }];

    // Conflict 1: Slug exists with incompatible name
    const db1 = createMockDb({
      books: [{ id: 'b-1', isbn: '9780000000001', title: 'Book A', author: 'Author A' }],
      genres: [{ id: 'g-1', name: 'Old Sci-Fi Name', slug: 'science-fiction' }],
    });

    const res1 = await analyzeGenreEnrichment(db1, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });
    assert.equal(res1.summary.genreConflicts, 1);
    assert.equal(res1.details.preflightSafe, false);

    // Conflict 2: Name exists with different slug
    const db2 = createMockDb({
      books: [{ id: 'b-1', isbn: '9780000000001', title: 'Book A', author: 'Author A' }],
      genres: [{ id: 'g-1', name: 'Science Fiction', slug: 'sci-fi-different' }],
    });

    const res2 = await analyzeGenreEnrichment(db2, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });
    assert.equal(res2.summary.genreConflicts, 1);
    assert.equal(res2.details.preflightSafe, false);
  });

  await t.test('8. Missing genre creation and existing genre reuse', async () => {
    const catalogBooks = [
      { title: 'Book A', author: 'Author A', isbn: '9780000000001' },
      { title: 'Book B', author: 'Author B', isbn: '9780000000002' },
    ];
    const genresByIsbn = new Map([
      ['9780000000001', ['existing-genre']],
      ['9780000000002', ['new-genre']],
    ]);
    const taxonomy = [
      { name: 'Existing Genre', slug: 'existing-genre' },
      { name: 'New Genre', slug: 'new-genre' },
    ];

    const db = createMockDb({
      books: [
        { id: 'b-1', isbn: '9780000000001', title: 'Book A', author: 'Author A' },
        { id: 'b-2', isbn: '9780000000002', title: 'Book B', author: 'Author B' },
      ],
      genres: [{ id: 'g-1', name: 'Existing Genre', slug: 'existing-genre' }],
    });

    const { summary, details } = await analyzeGenreEnrichment(db, {
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(summary.existingCanonicalGenres, 1);
    assert.equal(summary.newCanonicalGenres, 1);
    assert.equal(details.genresToCreate.length, 1);
    assert.equal(details.genresToCreate[0].slug, 'new-genre');
  });

  await t.test('9. Add missing links, remove stale links, leave non-curated books untouched', async () => {
    const catalogBooks = [
      { title: 'Curated 1', author: 'Author A', isbn: '9780000000001' },
    ];
    const genresByIsbn = new Map([
      ['9780000000001', ['genre-keep', 'genre-add']],
    ]);
    const taxonomy = [
      { name: 'Genre Keep', slug: 'genre-keep' },
      { name: 'Genre Add', slug: 'genre-add' },
      { name: 'Genre Stale', slug: 'genre-stale' },
    ];

    const db = createMockDb({
      books: [
        { id: 'b-curated', isbn: '9780000000001', title: 'Curated 1', author: 'Author A' },
        { id: 'b-noncurated', isbn: '9789999999999', title: 'Non Curated', author: 'Author X' },
      ],
      genres: [
        { id: 'g-keep', name: 'Genre Keep', slug: 'genre-keep' },
        { id: 'g-add', name: 'Genre Add', slug: 'genre-add' },
        { id: 'g-stale', name: 'Genre Stale', slug: 'genre-stale' },
      ],
      bookGenres: [
        { bookId: 'b-curated', genreId: 'g-keep' },
        { bookId: 'b-curated', genreId: 'g-stale' }, // stale link on curated book
        { bookId: 'b-noncurated', genreId: 'g-stale' }, // stale link on NON-curated book (MUST NOT BE TOUCHED!)
      ],
    });

    // 1. Dry run
    const dryRunResult = await enrichCatalogGenres(db, {
      apply: false,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(dryRunResult.summary.linksToAdd, 1);
    assert.equal(dryRunResult.summary.linksToRemove, 1);
    assert.equal(dryRunResult.summary.createdGenres, 0);
    assert.equal(dryRunResult.summary.addedLinks, 0);
    assert.equal(dryRunResult.summary.removedLinks, 0);
    assert.equal(db._writes.transactions, 0);

    // 2. Apply
    const applyResult = await enrichCatalogGenres(db, {
      apply: true,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });

    assert.equal(applyResult.summary.createdGenres, 0);
    assert.equal(applyResult.summary.addedLinks, 1);
    assert.equal(applyResult.summary.removedLinks, 1);
    assert.equal(applyResult.summary.bookRowsUpdated, 0);

    // Verify final state in DB
    const curatedLinks = db._state.bookGenres.filter(bg => bg.bookId === 'b-curated');
    const curatedGenreIds = curatedLinks.map(l => l.genreId).sort();
    assert.deepEqual(curatedGenreIds, ['g-add', 'g-keep'].sort());

    // CRITICAL: Non-curated book STILL has g-stale link!
    const nonCuratedLinks = db._state.bookGenres.filter(bg => bg.bookId === 'b-noncurated');
    assert.equal(nonCuratedLinks.length, 1);
    assert.equal(nonCuratedLinks[0].genreId, 'g-stale');
  });

  await t.test('10. Complete idempotency on second run', async () => {
    const catalogBooks = [
      { title: 'Book 1', author: 'Author 1', isbn: '9780000000001' },
    ];
    const genresByIsbn = new Map([['9780000000001', ['sci-fi']]]);
    const taxonomy = [{ name: 'Science Fiction', slug: 'sci-fi' }];

    const db = createMockDb({
      books: [{ id: 'b-1', isbn: '9780000000001', title: 'Book 1', author: 'Author 1' }],
      genres: [], // starts without genre
      bookGenres: [],
    });

    // Run 1: Apply
    const res1 = await enrichCatalogGenres(db, {
      apply: true,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });
    assert.equal(res1.summary.createdGenres, 1);
    assert.equal(res1.summary.addedLinks, 1);

    // Run 2: Dry-run should report 0 changes needed
    const res2 = await enrichCatalogGenres(db, {
      apply: false,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });
    assert.equal(res2.summary.newCanonicalGenres, 0);
    assert.equal(res2.summary.booksAlreadyCorrect, 1);
    assert.equal(res2.summary.booksNeedingChanges, 0);
    assert.equal(res2.summary.linksToAdd, 0);
    assert.equal(res2.summary.linksToRemove, 0);

    // Run 3: Second apply should make 0 modifications
    const res3 = await enrichCatalogGenres(db, {
      apply: true,
      sourceData: { taxonomy, catalogBooks, genresByIsbn },
    });
    assert.equal(res3.summary.createdGenres, 0);
    assert.equal(res3.summary.addedLinks, 0);
    assert.equal(res3.summary.removedLinks, 0);
  });
});
