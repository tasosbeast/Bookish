import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importLaunchCatalog, prepareLaunchCatalog } from '../scripts/catalog/launch-import.js';

function isbnAt(index) {
  const firstTwelve = `978${String(index).padStart(9, '0')}`;
  const total = [...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${firstTwelve}${(10 - total % 10) % 10}`;
}

function sourceEntry(index, overrides = {}) {
  return {
    key: `launch-book-${index}`,
    title: `Launch Book ${index}`,
    author: `Launch Author ${index}`,
    preferredIsbn13: isbnAt(index + 1000),
    ...overrides,
  };
}

function sourceManifest() {
  return Array.from({ length: 250 }, (_, index) => sourceEntry(index));
}

function mockDatabase(rows = []) {
  const books = new Map(rows.map(row => [row.isbn, structuredClone(row)]));
  const select = (row, fields) => Object.fromEntries(Object.keys(fields).filter(key => fields[key]).map(key => [key, row[key]]));
  const tx = {
    book: {
      findUnique: async ({ where, select: fields }) => {
        const row = books.get(where.isbn);
        return row ? select(row, fields) : null;
      },
      create: async ({ data }) => {
        const row = { id: `book-${books.size + 1}`, averageRating: null, ratingsCount: 0, ...data };
        books.set(row.isbn, row);
        return structuredClone(row);
      },
    },
  };
  return {
    book: {
      findMany: async ({ select: fields }) => [...books.values()]
        .map(row => select(row, fields)),
    },
    $transaction: async work => work(tx),
    rows: books,
  };
}

function reported(result) {
  const { unmappedExistingBooks, ...summary } = result;
  return summary;
}

test('launch catalog uses all 250 curated ISBNs and retains the 30 production pins', () => {
  const source = JSON.parse(readFileSync(new URL('../scripts/catalog-source.json', import.meta.url), 'utf8'));
  const entries = prepareLaunchCatalog(source);
  assert.equal(entries.length, 250);
  assert.equal(new Set(entries.map(entry => entry.isbn)).size, 250);
  assert.equal(entries.filter(entry => entry.pinnedIsbn13).length, 30);
  for (const entry of entries.filter(entry => entry.pinnedIsbn13)) assert.equal(entry.isbn, entry.pinnedIsbn13);
});

test('launch catalog dry-run is offline and performs no writes', async () => {
  const source = sourceManifest();
  const existing = prepareLaunchCatalog(source)[0];
  const db = mockDatabase([{ id: 'existing-book-id', ...existing, averageRating: 4, ratingsCount: 1, relations: { shelves: 1, reviews: 1, likes: 1 } }]);
  const before = structuredClone([...db.rows.values()]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('launch import must not fetch'); };
  try {
    const result = await importLaunchCatalog(db, source, { apply: false });
    assert.deepEqual(reported(result), { sourceEntries: 250, matchedExactIsbn: 1, matchedExistingWork: 0, created: 249, updated: 0, conflicts: 0, invalidEntries: 0 });
    assert.equal(result.unmappedExistingBooks.length, 0);
    assert.deepEqual([...db.rows.values()], before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('launch apply preserves a uniquely matched existing work with a different ISBN and user data', async () => {
  const source = sourceManifest();
  const sourceEntry = prepareLaunchCatalog(source)[0];
  const existingIsbn = isbnAt(900000000);
  const db = mockDatabase([{
    id: 'production-book-id', isbn: existingIsbn, title: sourceEntry.title, author: sourceEntry.author,
    description: 'Existing description', publicationYear: 2001, coverImageUrl: 'https://example.test/good-cover.jpg',
    averageRating: 4.5, ratingsCount: 2, relations: { userBooks: ['shelf'], reviews: ['review'], likes: ['like'] },
  }]);
  const before = structuredClone(db.rows.get(existingIsbn));
  const result = await importLaunchCatalog(db, source, { apply: true });
  assert.deepEqual(reported(result), { sourceEntries: 250, matchedExactIsbn: 0, matchedExistingWork: 1, created: 249, updated: 0, conflicts: 0, invalidEntries: 0 });
  assert.deepEqual(db.rows.get(existingIsbn), before);
  const created = db.rows.get(prepareLaunchCatalog(source)[1].isbn);
  assert.equal(created.description, null);
  assert.equal(created.publicationYear, null);
  assert.equal(created.coverImageUrl, `https://covers.openlibrary.org/b/isbn/${created.isbn}-L.jpg?default=false`);
});

test('launch matching accepts harmless exact-ISBN title suffixes and rejects wrong works', async () => {
  const source = sourceManifest();
  source[0] = sourceEntry(0, { title: 'Meditations', author: 'Marcus Aurelius' });
  source[1] = sourceEntry(1, { title: 'The Road', author: 'Cormac McCarthy' });
  const entries = prepareLaunchCatalog(source);
  const db = mockDatabase([
    { id: 'meditations', isbn: entries[0].isbn, title: 'Meditations (Penguin Classics)', author: 'Marcus Aurelius' },
    { id: 'road', isbn: entries[1].isbn, title: "The Road (Oprah's Book Club)", author: 'Cormac McCarthy' },
  ]);
  const result = await importLaunchCatalog(db, source, { apply: false });
  assert.deepEqual(reported(result), { sourceEntries: 250, matchedExactIsbn: 2, matchedExistingWork: 0, created: 248, updated: 0, conflicts: 0, invalidEntries: 0 });

  const wrongBook = mockDatabase([{ id: 'wrong-book', isbn: entries[0].isbn, title: 'Different Book', author: 'Different Author' }]);
  const wrongResult = await importLaunchCatalog(wrongBook, source, { apply: false });
  assert.equal(wrongResult.conflicts, 1);
  await assert.rejects(() => importLaunchCatalog(wrongBook, source, { apply: true }), { code: 'identity_conflict' });
  assert.equal(wrongBook.rows.size, 1);
});

test('launch apply stops before writes for invalid source data, reused rows and conflicts', async () => {
  const db = mockDatabase();
  await assert.rejects(() => importLaunchCatalog(db, sourceManifest().slice(0, 249), { apply: false }), { code: 'invalid_source_count' });

  const source = sourceManifest();
  const entry = prepareLaunchCatalog(source)[0];
  const conflictDb = mockDatabase([{ id: 'different-book', isbn: entry.isbn, title: 'Different Book', author: 'Different Author' }]);
  const dryRun = await importLaunchCatalog(conflictDb, source, { apply: false });
  assert.deepEqual(reported(dryRun), { sourceEntries: 250, matchedExactIsbn: 0, matchedExistingWork: 0, created: 249, updated: 0, conflicts: 1, invalidEntries: 0 });
  await assert.rejects(() => importLaunchCatalog(conflictDb, source, { apply: true }), { code: 'identity_conflict' });
  assert.equal(conflictDb.rows.size, 1);

  const pinnedSource = sourceManifest();
  pinnedSource[0].pinnedIsbn13 = pinnedSource[0].preferredIsbn13;
  const missingPinDb = mockDatabase();
  const pinDryRun = await importLaunchCatalog(missingPinDb, pinnedSource, { apply: false });
  assert.equal(pinDryRun.conflicts, 0);
  const pinApply = await importLaunchCatalog(missingPinDb, pinnedSource, { apply: true });
  assert.equal(pinApply.created, 250);

  const reusedSource = sourceManifest();
  reusedSource[0] = sourceEntry(0, { title: 'Meditations', author: 'Marcus Aurelius' });
  reusedSource[1] = sourceEntry(1, { title: 'Meditations (Penguin Classics)', author: 'Marcus Aurelius' });
  const reusableBook = mockDatabase([{ id: 'one-book', isbn: isbnAt(900000001), title: 'Meditations', author: 'Marcus Aurelius' }]);
  const reusedDryRun = await importLaunchCatalog(reusableBook, reusedSource, { apply: false });
  assert.equal(reusedDryRun.matchedExistingWork, 1);
  assert.equal(reusedDryRun.conflicts, 1);
  await assert.rejects(() => importLaunchCatalog(reusableBook, reusedSource, { apply: true }), { code: 'identity_conflict' });
  assert.equal(reusableBook.rows.size, 1);
});
